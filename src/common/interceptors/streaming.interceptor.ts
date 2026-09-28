import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
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
 * When neither condition is present the interceptor keeps the standard JSON
 * response path unchanged.
 *
 * The NDJSON format uses one JSON line per item:
 *   {"id":"...","status":"ACTIVE",...}\n
 *   {"id":"...","status":"ACTIVE",...}\n
 *   ...
 *
 * Pagination metadata is exposed as response headers on *every* list response,
 * streaming or not, so clients never have to parse the wrapper object just to
 * get count info:
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
      // JSON path: same pagination headers as the NDJSON path, so
      // X-Total-Count is present whether or not the client asked to stream.
      return next.handle().pipe(
        map((payload: unknown) => {
          this.applyPaginationHeaders(response, payload);
          return payload;
        }),
      );
    }

    return next.handle().pipe(
      switchMap((payload: unknown) => {
        this.applyPaginationHeaders(response, payload);

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

        response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');

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

  /**
   * Mirrors the envelope's pagination fields onto response headers. Missing
   * fields are simply skipped (headers must not be sent with an empty value),
   * and a `total` of 0 is still reported so clients can tell "empty page"
   * from "header absent".
   */
  private applyPaginationHeaders(response: Response, payload: unknown): void {
    if (payload === null || typeof payload !== 'object') return;

    const envelope = payload as Record<string, unknown>;
    const headers: Array<[string, unknown]> = [
      ['X-Total-Count', envelope['total']],
      ['X-Page',        envelope['page']],
      ['X-Limit',       envelope['limit']],
    ];

    for (const [header, value] of headers) {
      if (value !== undefined && value !== null) {
        response.setHeader(header, String(value));
      }
    }
  }
}
