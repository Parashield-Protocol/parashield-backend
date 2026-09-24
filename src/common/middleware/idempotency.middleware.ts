import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

// #438 — Idempotency keys prevent duplicate processing of the same request.
// A client that retries a POST (e.g. after a network timeout) sends the same
// Idempotency-Key header; we return the cached response instead of re-running
// the handler. Only applies to mutating methods (POST, PUT, PATCH).
const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24 h — matches typical API conventions
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

// #484 — per-key lock so concurrent requests with the same key don't both
// run the handler. The lock TTL sits just above the 30 s request timeout
// (see request-timeout.middleware.ts) so a crashed holder can't wedge the
// key forever, and waiters give up slightly before that timeout fires so
// they can answer with a clean 409 instead of a generic timeout.
const IDEMPOTENCY_LOCK_TTL_SECONDS = 35;
const IDEMPOTENCY_WAIT_TIMEOUT_MS = 25_000;
const IDEMPOTENCY_POLL_INTERVAL_MS = 100;

// Compare-and-delete: only the request holding the lock may release it.
const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

/**
 * IdempotencyMiddleware (#438)
 *
 * Intercepts POST/PUT/PATCH requests that include an `Idempotency-Key` header.
 *
 * First call  — processes normally, caches the response body + status in Redis
 *               for 24 hours under the key `idempotency:{method}:{path}:{key}`.
 * Repeat call — returns the cached response immediately with a
 *               `X-Idempotent-Replayed: true` header so callers can detect it.
 * Concurrent  — (#484) only the request holding the Redis lock
 *               (`SET ... NX EX`) runs the handler; others wait for its cached
 *               response and replay it, or get 409 if it doesn't finish in time.
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

    // Guard against calling next() twice if Redis fails after the handler
    // has already been started under the lock.
    let nextCalled = false;
    const nextOnce: NextFunction = (err?: unknown) => {
      if (nextCalled) return;
      nextCalled = true;
      next(err);
    };

    this.handle(storeKey, rawKey, res, nextOnce).catch((err: unknown) => {
      // Redis unavailable — fail open (process the request normally) so a
      // Redis outage doesn't take down the API. Log as a warning so ops can
      // detect the degradation.
      this.logger.warn(
        `Idempotency Redis lookup failed for key=${rawKey}: ${err instanceof Error ? err.message : String(err)}. Processing request without idempotency check.`,
      );
      if (!res.headersSent) nextOnce();
    });
  }

  /**
   * #484 — replay a cached response if one exists; otherwise take the
   * per-key lock and run the handler. A concurrent request that loses the
   * lock race polls until the winner's response is cached (and replays it),
   * the winner releases the lock without caching (non-2xx — we then retry
   * acquiring the lock and run the handler ourselves), or the wait times out.
   */
  private async handle(storeKey: string, rawKey: string, res: Response, next: NextFunction): Promise<void> {
    const lockKey = `${storeKey}:lock`;
    const lockToken = randomUUID();
    const deadline = Date.now() + IDEMPOTENCY_WAIT_TIMEOUT_MS;

    for (;;) {
      if (await this.replayCached(storeKey, rawKey, res)) return;

      const acquired = await this.redis.set(lockKey, lockToken, 'EX', IDEMPOTENCY_LOCK_TTL_SECONDS, 'NX');
      if (acquired === 'OK') {
        // Another request may have cached its response between our cache
        // read and lock acquisition — re-check so we never run the handler
        // twice for a key that has already completed.
        if (await this.replayCached(storeKey, rawKey, res)) {
          await this.releaseLock(lockKey, lockToken, rawKey);
          return;
        }
        this.runWithLock(storeKey, lockKey, lockToken, rawKey, res, next);
        return;
      }

      if (Date.now() >= deadline) {
        this.logger.warn(`Timed out waiting for in-flight request with idempotency key=${rawKey}`);
        res.status(409).json({
          success: false,
          errorCode: 'IDEMPOTENCY_CONFLICT',
          error: 'A request with this Idempotency-Key is still being processed. Retry later.',
          statusCode: 409,
        });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, IDEMPOTENCY_POLL_INTERVAL_MS));
    }
  }

  /** Send the cached response for `storeKey` if present. Returns true if replayed. */
  private async replayCached(storeKey: string, rawKey: string, res: Response): Promise<boolean> {
    const cached = await this.redis.get(storeKey);
    if (!cached) return false;
    try {
      const { status, body } = JSON.parse(cached) as { status: number; body: unknown };
      this.logger.debug(`Replaying idempotent response for key=${rawKey}`);
      res.setHeader('X-Idempotent-Replayed', 'true');
      res.status(status).json(body);
      return true;
    } catch {
      // Corrupted cache entry — fall through to normal processing.
      this.logger.warn(`Failed to parse cached idempotency entry for key=${rawKey}`);
      return false;
    }
  }

  private runWithLock(
    storeKey: string,
    lockKey: string,
    lockToken: string,
    rawKey: string,
    res: Response,
    next: NextFunction,
  ): void {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      void this.releaseLock(lockKey, lockToken, rawKey);
    };

    // Intercept the response so we can cache it before it is sent. The lock
    // is released only after the cache write settles, so waiters polling for
    // the cached entry never observe "no lock and no cache" for a success.
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      // Only cache successful responses (2xx) to avoid caching transient errors.
      if (res.statusCode >= 200 && res.statusCode < 300 && !released) {
        released = true;
        const entry = JSON.stringify({ status: res.statusCode, body });
        this.redis
          .set(storeKey, entry, 'EX', IDEMPOTENCY_TTL_SECONDS)
          .catch((err: unknown) =>
            this.logger.warn(
              `Failed to store idempotency key=${rawKey}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          )
          .finally(() => this.releaseLock(lockKey, lockToken, rawKey));
      }
      return originalJson(body);
    };

    // Non-JSON, non-2xx, or aborted responses: release the lock so a retry
    // (or a waiting concurrent request) can proceed.
    res.on('finish', release);
    res.on('close', release);

    next();
  }

  /** Delete the lock only if we still own it (it may have expired and been re-acquired). */
  private async releaseLock(lockKey: string, lockToken: string, rawKey: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockToken);
    } catch (err) {
      this.logger.warn(
        `Failed to release idempotency lock for key=${rawKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
