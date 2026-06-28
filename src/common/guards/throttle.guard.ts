import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';

interface RequestWindow {
  count: number;
  windowStart: number;
}

@Injectable()
export class ThrottleGuard implements CanActivate {
  private readonly requests = new Map<string, RequestWindow>();
  private readonly MAX_REQUESTS = 60;
  private readonly TIME_WINDOW_MS = 60_000;

  constructor() {
    setInterval(() => {
      const now = Date.now();
      for (const [ip, window] of this.requests) {
        if (now - window.windowStart > this.TIME_WINDOW_MS) {
          this.requests.delete(ip);
        }
      }
    }, this.TIME_WINDOW_MS).unref();
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const ip = this.extractIP(request);
    const now = Date.now();

    const window = this.requests.get(ip);

    if (!window || now - window.windowStart > this.TIME_WINDOW_MS) {
      this.requests.set(ip, { count: 1, windowStart: now });
      return true;
    }

    if (window.count >= this.MAX_REQUESTS) {
      const retryAfter = Math.ceil(
        (window.windowStart + this.TIME_WINDOW_MS - now) / 1000,
      );
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
    return true;
  }

  private extractIP(request: Request): string {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    return request.ip ?? request.socket.remoteAddress ?? 'unknown';
  }
}
