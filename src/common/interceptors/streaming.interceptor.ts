import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  StreamableFile,
} from '@nestjs/common';
import { Observable, Subscription, isObservable } from 'rxjs';
import { map } from 'rxjs/operators';
import { PassThrough } from 'stream';
import { Request, Response } from 'express';

export interface StreamResourceHolder {
  cursor?: { close?: () => void; release?: () => void; destroy?: () => void };
  abortController?: AbortController;
  timers?: Array<NodeJS.Timeout | number>;
  cleanup?: () => void;
}

/**
 * StreamingInterceptor — streams list responses (NDJSON) and SSE event streams (#440, #673).
 *
 * Handles both NDJSON list streaming and SSE event streams. On client disconnect
 * (`request.on('close')`), cleans up all associated resources idempotently:
 *   • Unsubscribes from active RxJS observables / pub-sub listeners
 *   • Clears intervals and timers (including heartbeats)
 *   • Closes and releases DB cursors or connections
 *   • Aborts in-flight upstream work via AbortController
 *   • Destroys PassThrough streams so nothing more is written to closed responses.
 *
 * Normal completion and error paths also trigger the same idempotent cleanup.
 */
@Injectable()
export class StreamingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http     = context.switchToHttp();
    const request  = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const wantsStream =
      request.headers['accept'] === 'application/x-ndjson' ||
      request.headers['accept'] === 'text/event-stream' ||
      request.query['stream'] === 'true';

    // If client is already disconnected when entering interceptor, complete immediately
    if (request.destroyed || response.writableEnded) {
      return new Observable((sub) => sub.complete());
    }

    if (!wantsStream) {
      // JSON path: mirror pagination headers without streaming body
      return next.handle().pipe(
        map((payload: unknown) => {
          this.applyPaginationHeaders(response, payload);
          return payload;
        }),
      );
    }

    return new Observable((subscriber) => {
      let isCleanedUp = false;
      let upstreamSub: Subscription | undefined;
      let innerSub: Subscription | undefined;
      const activeTimers = new Set<NodeJS.Timeout | number>();
      let passThrough: PassThrough | undefined;
      let cursorRef: { close?: () => void; release?: () => void; destroy?: () => void } | undefined;
      let abortController: AbortController | undefined;

      const cleanup = () => {
        if (isCleanedUp) return;
        isCleanedUp = true;

        // 1. Clear intervals and timers (including heartbeats)
        for (const t of activeTimers) {
          clearInterval(t as any);
          clearTimeout(t as any);
        }
        activeTimers.clear();

        // 2. Unsubscribe from upstream observable and inner observable
        if (innerSub && !innerSub.closed) {
          innerSub.unsubscribe();
        }
        if (upstreamSub && !upstreamSub.closed) {
          upstreamSub.unsubscribe();
        }

        // 3. Close and release DB cursors or connections
        if (cursorRef) {
          try {
            if (typeof cursorRef.close === 'function') {
              cursorRef.close();
            } else if (typeof cursorRef.release === 'function') {
              cursorRef.release();
            } else if (typeof cursorRef.destroy === 'function') {
              cursorRef.destroy();
            }
          } catch {
            // Ignore errors on cursor cleanup
          }
          cursorRef = undefined;
        }

        // 4. Abort in-flight upstream work
        if (abortController) {
          try {
            abortController.abort();
          } catch {
            // Ignore errors on abort
          }
          abortController = undefined;
        }

        // 5. Destroy passThrough stream and ensure no further writes
        if (passThrough && !passThrough.destroyed) {
          passThrough.destroy();
        }

        // 6. Remove request/response event listeners
        request.off?.('close', onDisconnect);
        request.off?.('end', onDisconnect);
        response.off?.('close', onDisconnect);
        response.off?.('finish', onDisconnect);

        if (!subscriber.closed) {
          subscriber.complete();
        }
      };

      const onDisconnect = () => {
        cleanup();
      };

      request.once?.('close', onDisconnect);
      request.once?.('end', onDisconnect);
      response.once?.('close', onDisconnect);
      response.once?.('finish', onDisconnect);

      upstreamSub = next.handle().subscribe({
        next: (payload: unknown) => {
          if (isCleanedUp || request.destroyed || response.writableEnded) {
            cleanup();
            return;
          }

          // Extract resource holder references if provided in payload
          if (payload && typeof payload === 'object') {
            const holder = payload as StreamResourceHolder;
            if (holder.cursor) cursorRef = holder.cursor;
            if (holder.abortController) abortController = holder.abortController;
            if (Array.isArray(holder.timers)) {
              for (const t of holder.timers) activeTimers.add(t);
            }
            if (typeof holder.cleanup === 'function') {
              const origCleanup = holder.cleanup;
              holder.cleanup = () => {
                origCleanup();
                cleanup();
              };
            }
          }

          this.applyPaginationHeaders(response, payload);

          // If payload is an Observable (e.g. SSE event stream)
          if (isObservable(payload)) {
            innerSub = (payload as Observable<unknown>).subscribe({
              next: (val) => {
                if (isCleanedUp || request.destroyed || response.writableEnded) {
                  cleanup();
                  return;
                }
                subscriber.next(val);
              },
              error: (err) => {
                cleanup();
                subscriber.error(err);
              },
              complete: () => {
                cleanup();
              },
            });
            return;
          }

          // If payload is an individual SSE MessageEvent object
          if (
            payload !== null &&
            typeof payload === 'object' &&
            'data' in (payload as Record<string, unknown>) &&
            request.headers['accept'] === 'text/event-stream'
          ) {
            subscriber.next(payload);
            return;
          }

          // Non-list responses pass through unchanged
          if (
            payload === null ||
            typeof payload !== 'object' ||
            !Array.isArray((payload as Record<string, unknown>)['data'])
          ) {
            subscriber.next(payload);
            cleanup();
            return;
          }

          const envelope = payload as Record<string, unknown>;
          const items = envelope['data'] as unknown[];

          response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
          // #702 — set SSE-compatible headers for streaming responses
          response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          response.setHeader('Connection', 'keep-alive');

          passThrough = new PassThrough();

          // Write each item as a JSON line asynchronously
          setImmediate(() => {
            try {
              for (const item of items) {
                if (isCleanedUp || passThrough.destroyed || request.destroyed || response.writableEnded) {
                  break;
                }
                passThrough.write(JSON.stringify(item, (_k, v) => typeof v === 'bigint' ? v.toString() : v) + '\n');
              }
              if (!isCleanedUp && !passThrough.destroyed) {
                passThrough.end();
              }
            } catch (err) {
              if (!passThrough.destroyed) {
                passThrough.destroy(err instanceof Error ? err : new Error(String(err)));
              }
              cleanup();
            }
          });

          subscriber.next(
            new StreamableFile(passThrough, {
              type: 'application/x-ndjson',
            }),
          );
        },
        error: (err) => {
          cleanup();
          subscriber.error(err);
        },
        complete: () => {
          if (!passThrough && !innerSub) {
            cleanup();
          }
        },
      });

      return () => {
        cleanup();
      };
    });
  }

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
