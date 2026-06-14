import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';

interface RequestWindow {
  count:     number;
  windowStart: number;
}

/**
 * ThrottleGuard — IP-based rate limiting guard.
 *
 * Allows up to MAX_REQUESTS per TIME_WINDOW_MS (default: 60 req / 60 seconds).
 * Uses an in-memory Map keyed by IP address. Not suitable for multi-instance
 * deployments — use Redis for distributed rate limiting in production.
 */
@Injectable()
export class ThrottleGuard implements CanActivate {
  private readonly logger = new Logger(ThrottleGuard.name);
  private readonly requests = new Map<string, RequestWindow>();

  private readonly MAX_REQUESTS    = 60;
  private readonly TIME_WINDOW_MS  = 60 * 1000; // 60 seconds

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const ip      = this.getClientIp(request);

    const now    = Date.now();
    const window = this.requests.get(ip);

    if (!window || now - window.windowStart > this.TIME_WINDOW_MS) {
      // New window for this IP
      this.requests.set(ip, { count: 1, windowStart: now });
      return true;
    }

    if (window.count >= this.MAX_REQUESTS) {
      this.logger.warn(
        `Rate limit exceeded for IP: ${ip} — ${window.count} requests in ${this.TIME_WINDOW_MS / 1000}s`,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message:    'Too many requests',
          retryAfter: Math.ceil((window.windowStart + this.TIME_WINDOW_MS - now) / 1000),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Increment counter within the same window
    window.count += 1;
    this.requests.set(ip, window);
    return true;
  }

  private getClientIp(request: Request): string {
    const forwarded = request.headers['x-forwarded-for'];
    if (forwarded) {
      return Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0].trim();
    }
    return request.ip ?? 'unknown';
  }
}
