import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  OnModuleDestroy,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface RequestWindow {
  count: number;
  windowStart: number;
}

@Injectable()
export class ThrottleGuard implements CanActivate, OnModuleDestroy {
  private readonly requests = new Map<string, RequestWindow>();
  private readonly MAX_REQUESTS = 60;
  private readonly TIME_WINDOW_MS = 60_000;
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // #337 — entries are always re-inserted (delete+set) whenever their
    // window resets, so Map iteration order (insertion order) doubles as
    // oldest-window-first order. That lets cleanup stop at the first
    // still-active entry instead of scanning the whole map every sweep.
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [ip, window] of this.requests) {
        if (now - window.windowStart <= this.TIME_WINDOW_MS) {
          break;
        }
        this.requests.delete(ip);
      }
    }, this.TIME_WINDOW_MS);
    this.cleanupInterval.unref();
  }

  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const ip = this.extractIP(request);
    const now = Date.now();

    const window = this.requests.get(ip);

    if (!window || now - window.windowStart > this.TIME_WINDOW_MS) {
      // Re-inserting (rather than updating in place) moves this IP to the
      // end of Map iteration order, keeping entries ordered oldest-first
      // for the cleanup sweep above.
      this.requests.delete(ip);
      this.requests.set(ip, { count: 1, windowStart: now });
      this.setRateLimitHeaders(response, 1, now);
      return true;
    }

    if (window.count >= this.MAX_REQUESTS) {
      const retryAfter = Math.ceil(
        (window.windowStart + this.TIME_WINDOW_MS - now) / 1000,
      );
      const resetAt = Math.ceil((window.windowStart + this.TIME_WINDOW_MS) / 1000);
      response.setHeader('X-RateLimit-Limit', this.MAX_REQUESTS);
      response.setHeader('X-RateLimit-Remaining', 0);
      response.setHeader('X-RateLimit-Reset', resetAt);
      response.setHeader('Retry-After', retryAfter);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many requests. Please try again later.',
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
        {
          cause: { retryAfter },
        },
      );
    }

    window.count++;
    this.setRateLimitHeaders(response, window.count, window.windowStart);
    return true;
  }

  private setRateLimitHeaders(
    response: Response,
    used: number,
    windowStart: number,
  ): void {
    const resetAt = Math.ceil((windowStart + this.TIME_WINDOW_MS) / 1000);
    response.setHeader('X-RateLimit-Limit', this.MAX_REQUESTS);
    response.setHeader('X-RateLimit-Remaining', Math.max(0, this.MAX_REQUESTS - used));
    response.setHeader('X-RateLimit-Reset', resetAt);
  }

  private extractIP(request: Request): string {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    return request.ip ?? request.socket.remoteAddress ?? 'unknown';
  }
}
