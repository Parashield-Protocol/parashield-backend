import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';

// #438 — Idempotency keys prevent duplicate processing of the same request.
// A client that retries a POST (e.g. after a network timeout) sends the same
// Idempotency-Key header; we return the cached response instead of re-running
// the handler. Only applies to mutating methods (POST, PUT, PATCH).
const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24 h — matches typical API conventions
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/**
 * IdempotencyMiddleware (#438)
 *
 * Intercepts POST/PUT/PATCH requests that include an `Idempotency-Key` header.
 *
 * First call  — processes normally, caches the response body + status in Redis
 *               for 24 hours under the key `idempotency:{method}:{path}:{key}`.
 * Repeat call — returns the cached response immediately with a
 *               `X-Idempotent-Replayed: true` header so callers can detect it.
 *
 * Requests without the header pass through unchanged, so the middleware is
 * completely opt-in and does not affect existing clients.
 *
 * Register in main.ts after body parsers:
 *   const idempotency = new IdempotencyMiddleware(redisClient);
 *   app.use((req, res, next) => idempotency.use(req, res, next));
 */
@Injectable()
export class IdempotencyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(IdempotencyMiddleware.name);

  constructor(private readonly redis: Redis) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const MUTATING_METHODS = ['POST', 'PUT', 'PATCH'];
    if (!MUTATING_METHODS.includes(req.method)) {
      return next();
    }

    const rawKey = req.headers['idempotency-key'] as string | undefined;
    if (!rawKey) {
      return next();
    }

    // Basic validation — reject keys that are too long or contain newlines
    // (could be used to construct arbitrary Redis keys).
    if (rawKey.length > IDEMPOTENCY_KEY_MAX_LENGTH || /[\r\n]/.test(rawKey)) {
      res.status(400).json({
        success: false,
        errorCode: 'BAD_REQUEST',
        error: 'Invalid Idempotency-Key header value',
        statusCode: 400,
      });
      return;
    }

    const storeKey = `idempotency:${req.method}:${req.path}:${rawKey}`;

    this.redis.get(storeKey).then((cached) => {
      if (cached) {
        try {
          const { status, body } = JSON.parse(cached) as { status: number; body: unknown };
          this.logger.debug(`Replaying idempotent response for key=${rawKey}`);
          res.setHeader('X-Idempotent-Replayed', 'true');
          res.status(status).json(body);
          return;
        } catch {
          // Corrupted cache entry — fall through to normal processing.
          this.logger.warn(`Failed to parse cached idempotency entry for key=${rawKey}`);
        }
      }

      // Intercept the response so we can cache it before it is sent.
      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        // Only cache successful responses (2xx) to avoid caching transient errors.
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const entry = JSON.stringify({ status: res.statusCode, body });
          this.redis
            .set(storeKey, entry, 'EX', IDEMPOTENCY_TTL_SECONDS)
            .catch((err: unknown) =>
              this.logger.warn(
                `Failed to store idempotency key=${rawKey}: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
        }
        return originalJson(body);
      };

      next();
    }).catch((err: unknown) => {
      // Redis unavailable — fail open (process the request normally) so a
      // Redis outage doesn't take down the API. Log as a warning so ops can
      // detect the degradation.
      this.logger.warn(
        `Idempotency Redis lookup failed for key=${rawKey}: ${err instanceof Error ? err.message : String(err)}. Processing request without idempotency check.`,
      );
      next();
    });
  }
}
