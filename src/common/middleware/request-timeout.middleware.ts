import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

// #409 — configurable request timeout. Long-running requests can exhaust
// worker threads; responding with 408 lets the client retry instead of
// hanging until the TCP idle-timeout fires. The value is intentionally kept
// in sync with SERVER_TIMEOUT_MS in main.ts (30 s) so both layers agree.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * RequestTimeoutMiddleware (#409)
 *
 * Attaches a per-request timer. If the handler has not finished (i.e. the
 * response has not been sent) within the configured window, it writes a
 * 408 Request Timeout response and destroys the underlying socket so the
 * worker slot is freed immediately.
 *
 * The timer is cleared on the response `finish` event so normal requests are
 * not affected.
 *
 * Registered globally in main.ts alongside the other Express middleware,
 * immediately after the body parsers so every route is covered.
 */
@Injectable()
export class RequestTimeoutMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestTimeoutMiddleware.name);
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      this.logger.warn(
        `Request timeout after ${this.timeoutMs}ms: ${req.method} ${req.url}`,
      );
      res.status(408).json({
        statusCode: 408,
        error: 'Request Timeout',
        message: 'The request exceeded the maximum allowed processing time.',
      });
      // Destroy the socket so the connection slot is released immediately.
      req.socket?.destroy();
    }, this.timeoutMs);

    // Clear the timer as soon as the response is fully flushed.
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));

    next();
  }
}
