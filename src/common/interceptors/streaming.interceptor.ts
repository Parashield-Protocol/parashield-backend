import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { PassThrough } from 'stream';
import { Request, Response } from 'express';

/**
 * StreamingInterceptor — streams large list responses as NDJSON to reduce
 * peak memory usage (#440).
 *
 * Instead of buffering the full result array and serialising it as a single
 * JSON payload, the interceptor writes each item as an individual JSON line
 * (newline-delimited JSON / NDJSON) through a PassThrough Node stream. The
 * Express response is flushed chunk-by-chunk with Transfer-Encoding: chunked,
 * so the server never holds the entire serialised payload in memory at once.
 *
 * Opt-in trigger (either condition activates streaming):
 *   • Request header:  Accept: application/x-ndjson
 *   • Query parameter: ?stream=true
 *
 * When neither condition is present the interceptor is a no-op and the
 * standard JSON response path is used unchanged.
 *
 * The NDJSON format uses one JSON line per item:
 *   {"id":"...","status":"ACTIVE",...}\n
 *   {"id":"...","status":"ACTIVE",...}\n
 *   ...
 *
 * Clients that need the full metadata envelope (success, total, page, limit)
 * can either use the standard (non-streaming) response or read the custom
 * response headers:
 *   X-Total-Count  — total number of items in the list
 *   X-Page         — page number returned (when applicable)
 *   X-Limit        — page size (when applicable)
 *
 * Usage:
 *   @UseInterceptors(StreamingInterceptor)
 *   @Get('some-list')
 *   async list(...) { ... }
 */
@Injectable()
export class StreamingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http     = context.switchToHttp();
    const request  = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const wantsStream =
      request.headers['accept'] === 'application/x-ndjson' ||
      request.query['stream'] === 'true';

    if (!wantsStream) {
      return next.handle();
    }

    return next.handle().pipe(
      switchMap((payload: unknown) => {
        // Only stream responses that carry a data array.
        // Non-list responses (single objects, errors) pass through unchanged.
        if (
          payload === null ||
          typeof payload !== 'object' ||
          !Array.isArray((payload as Record<string, unknown>)['data'])
        ) {
          return new Observable(subscriber => {
            subscriber.next(payload);
            subscriber.complete();
          });
        }

        const envelope  = payload as Record<string, unknown>;
        const items     = envelope['data'] as unknown[];
        const total     = envelope['total'];
        const page      = envelope['page'];
        const limit     = envelope['limit'];

        // Expose pagination metadata via response headers so NDJSON clients
        // don't have to parse a wrapper object just to get count info.
        response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        if (total !== undefined) {
          response.setHeader('X-Total-Count', String(total));
        }
        if (page !== undefined) {
          response.setHeader('X-Page', String(page));
        }
        if (limit !== undefined) {
          response.setHeader('X-Limit', String(limit));
        }

        // Build a PassThrough stream and write each item as a JSON line.
        const passThrough = new PassThrough();

        // Schedule writes asynchronously so the stream is returned to NestJS
        // before we start pushing data (avoids blocking the event loop).
        setImmediate(() => {
          try {
            for (const item of items) {
              passThrough.write(JSON.stringify(item) + '\n');
            }
            passThrough.end();
          } catch (err) {
            passThrough.destroy(err instanceof Error ? err : new Error(String(err)));
          }
        });

        // Return a StreamableFile so NestJS hands off the stream to Express
        // and uses Transfer-Encoding: chunked automatically.
        return new Observable(subscriber => {
          subscriber.next(new StreamableFile(passThrough, {
            type: 'application/x-ndjson',
          }));
          subscriber.complete();
        });
      }),
    );
  }
}
