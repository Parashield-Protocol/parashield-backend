import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';

/** Query parameters whose values must never appear in logs. */
const SENSITIVE_PARAMS = new Set([
  'wallet', 'secret', 'token', 'key', 'apikey', 'api_key',
  'authorization', 'password', 'seed', 'private_key',
]);

/**
 * LoggingInterceptor — logs every incoming request and its response time.
 *
 * Logs at the start of each request and on completion via tap().
 * Sensitive query parameters (wallet addresses, tokens, keys) are masked
 * to prevent them from leaking into log aggregation systems.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  /** Returns the URL with sensitive query parameter values replaced by ***. */
  private sanitizeUrl(url: string): string {
    const questionMark = url.indexOf('?');
    if (questionMark === -1) return url;

    const base = url.slice(0, questionMark);
    const queryString = url.slice(questionMark + 1);
    const sanitized = queryString.split('&').map((pair) => {
      const eqIndex = pair.indexOf('=');
      if (eqIndex === -1) return pair;
      const key = pair.slice(0, eqIndex).toLowerCase();
      if (SENSITIVE_PARAMS.has(key)) {
        return `${pair.slice(0, eqIndex + 1)}***`;
      }
      return pair;
    }).join('&');

    return `${base}?${sanitized}`;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx     = context.switchToHttp();
    const request = ctx.getRequest<Request>();
    const { method, url } = request;
    const startTime = Date.now();
    const safeUrl = this.sanitizeUrl(url);

    this.logger.log(`→ ${method} ${safeUrl}`);

    return next.handle().pipe(
      tap({
        next: () => {
          const response = ctx.getResponse<Response>();
          const duration = Date.now() - startTime;
          this.logger.log(`← ${method} ${safeUrl} ${response.statusCode} — ${duration}ms`);
        },
        error: (err: unknown) => {
          const duration   = Date.now() - startTime;
          const statusCode = err instanceof Error && 'status' in err
            ? (err as { status: number }).status
            : 500;
          this.logger.warn(`← ${method} ${safeUrl} ${statusCode} — ${duration}ms (error)`);
        },
      }),
    );
  }
}
