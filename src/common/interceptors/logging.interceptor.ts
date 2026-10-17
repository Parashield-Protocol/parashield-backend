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

/** Request body fields whose values must never appear in logs (#666). */
const SENSITIVE_BODY_FIELDS = new Set([
  'password', 'secret', 'token', 'key', 'apikey', 'api_key',
  'authorization', 'seed', 'private_key', 'wallet', 'signature',
  'xdr', 'signedXdr', 'signed_xdr',
]);

/**
 * LoggingInterceptor — logs every incoming request and its response time.
 *
 * Logs at the start of each request and on completion via tap().
 * Sensitive query parameters (wallet addresses, tokens, keys) are masked
 * to prevent them from leaking into log aggregation systems.
 * Sensitive request body fields are masked before logging (#666).
 *
 * Body serialization is deferred to the async logger and truncated for
 * large payloads to avoid blocking the event loop (#690).
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');
  private readonly maxBodyLogLength = 2000;

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

  /** Recursively mask sensitive fields in an object (#666). */
  private sanitizeBody(body: unknown): unknown {
    if (body === null || body === undefined) return body;
    if (Array.isArray(body)) return body.map((item) => this.sanitizeBody(item));
    if (typeof body !== 'object') return body;

    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (SENSITIVE_BODY_FIELDS.has(normalizedKey)) {
        masked[key] = '***';
      } else if (typeof value === 'object' && value !== null) {
        masked[key] = this.sanitizeBody(value);
      } else {
        masked[key] = value;
      }
    }
    return masked;
  }

  /** Serialize and truncate body for logging, deferred to avoid blocking (#690). */
  private logBody(method: string, safeUrl: string, body: unknown): void {
    if (body === null || body === undefined || typeof body !== 'object') return;
    // Defer serialization to the next microtask to avoid blocking the event loop.
    setTimeout(() => {
      try {
        const sanitized = this.sanitizeBody(body);
        let serialized = JSON.stringify(sanitized);
        if (serialized.length > this.maxBodyLogLength) {
          serialized = serialized.slice(0, this.maxBodyLogLength) + '...[truncated]';
        }
        this.logger.debug(`  body: ${serialized}`);
      } catch {
        // Body serialization failure is not worth logging an error for.
      }
    }, 0);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx     = context.switchToHttp();
    const request = ctx.getRequest<Request>();
    const { method, url } = request;

    // Load balancer probes poll the health endpoint every few seconds; skip
    // them so they don't drown out real request logs.
    if (url.startsWith(HEALTH_PATH_PREFIX)) {
      return next.handle();
    }

    const startTime = Date.now();
    const safeUrl = this.sanitizeUrl(url);

    this.logger.log(`→ ${method} ${safeUrl}`);

    // Log body asynchronously (deferred) for non-GET requests (#690).
    if (method !== 'GET' && request.body) {
      this.logBody(method, safeUrl, request.body);
    }

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
