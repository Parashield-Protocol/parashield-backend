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

/**
 * LoggingInterceptor — logs every incoming request and its response time.
 *
 * Logs at the start of each request and on completion via tap().
 * Useful for monitoring slow endpoints and tracking API usage patterns.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx     = context.switchToHttp();
    const request = ctx.getRequest<Request>();
    const { method, url } = request;
    const startTime = Date.now();

    this.logger.log(`→ ${method} ${url}`);

    return next.handle().pipe(
      tap({
        next: () => {
          const response = ctx.getResponse<Response>();
          const duration = Date.now() - startTime;
          this.logger.log(`← ${method} ${url} ${response.statusCode} — ${duration}ms`);
        },
        error: (err: unknown) => {
          const duration   = Date.now() - startTime;
          const statusCode = err instanceof Error && 'status' in err
            ? (err as { status: number }).status
            : 500;
          this.logger.warn(`← ${method} ${url} ${statusCode} — ${duration}ms (error)`);
        },
      }),
    );
  }
}
