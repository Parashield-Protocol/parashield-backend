/**
 * #710 — Redis startup connection retry.
 *
 * The Redis client is created once (see redis.module.ts) with `lazyConnect`,
 * so creating it never blocks. This module owns the *startup* handshake:
 * it retries the first connection with exponential backoff, a capped delay,
 * jitter and a per-attempt timeout, and fails with one actionable error when
 * every attempt is exhausted.
 *
 * Division of responsibility (issue #710, point 5):
 *  - Startup connection attempts are owned by `connectWithRetry` below (driven
 *    by RedisConnectionService). While startup is in progress the client's
 *    `retryStrategy` returns `null`, so ioredis does not schedule background
 *    reconnects that would race this loop.
 *  - Runtime reconnection (after the first successful connection) is owned by
 *    ioredis via `retryStrategy`/`reconnectOnError`; RedisConnectionService
 *    swaps the runtime strategy in once startup succeeds.
 */

export interface RedisStartupRetryOptions {
  /** Maximum number of connection attempts (including the first). */
  maxAttempts: number;
  /** Delay before the second attempt, in milliseconds. Doubles each attempt. */
  initialDelayMs: number;
  /** Upper bound for the backoff delay, in milliseconds. */
  maxDelayMs: number;
  /** Hard timeout for a single connection attempt, in milliseconds. */
  attemptTimeoutMs: number;
}

export const DEFAULT_REDIS_STARTUP_RETRY: RedisStartupRetryOptions = {
  maxAttempts: 5,
  initialDelayMs: 200,
  maxDelayMs: 3_000,
  attemptTimeoutMs: 5_000,
};

export const REDIS_STARTUP_ENV_KEYS = {
  maxAttempts: 'REDIS_STARTUP_MAX_ATTEMPTS',
  initialDelayMs: 'REDIS_STARTUP_INITIAL_DELAY_MS',
  maxDelayMs: 'REDIS_STARTUP_MAX_DELAY_MS',
  attemptTimeoutMs: 'REDIS_STARTUP_ATTEMPT_TIMEOUT_MS',
} as const;

export interface RedisTarget {
  host: string;
  port: number;
}

/** Minimal shape of the ioredis client this module needs. */
export interface RedisConnectable {
  connect(): Promise<unknown>;
  disconnect?(reconnect?: boolean): void;
}

export interface ConnectRetryDeps {
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Returns a number in [0, 1). Injected so tests are deterministic. */
  random(): number;
}

export interface ConnectRetryLogger {
  warn(message: string): void;
}

/** Raised when a single connection attempt exceeds its timeout. */
export class RedisAttemptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Redis connection attempt timed out after ${timeoutMs}ms`);
    this.name = 'RedisAttemptTimeoutError';
  }
}

/**
 * Final, actionable startup failure. Deliberately contains only the host and
 * port — never the username, password or full connection URL.
 */
export class RedisStartupConnectionError extends Error {
  constructor(
    target: RedisTarget,
    attempts: number,
    elapsedMs: number,
    cause?: unknown,
  ) {
    super(
      `Unable to connect to Redis at ${target.host}:${target.port} after ${attempts} ` +
        `attempt(s) over ${elapsedMs}ms. Verify that Redis is running and reachable ` +
        `and that REDIS_URL is correct. Startup retries can be tuned with ` +
        `REDIS_STARTUP_MAX_ATTEMPTS, REDIS_STARTUP_INITIAL_DELAY_MS, ` +
        `REDIS_STARTUP_MAX_DELAY_MS and REDIS_STARTUP_ATTEMPT_TIMEOUT_MS.`,
    );
    this.name = 'RedisStartupConnectionError';
    if (cause !== undefined) {
      // ES2021 target: assign manually rather than using the Error options bag.
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

function readNonNegativeInt(
  get: (key: string) => string | undefined,
  key: string,
  fallback: number,
  minimum: number,
): number {
  const raw = get(key);
  if (raw === undefined || raw === null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum) return fallback;
  return parsed;
}

/**
 * Read the startup retry knobs from configuration, falling back to the
 * documented defaults. Values are validated up-front in app.module.ts's
 * `validateConfig`; the fallback here keeps the client usable even if an
 * invalid value slips through.
 */
export function readRedisStartupRetryOptions(
  get: (key: string) => string | undefined,
): RedisStartupRetryOptions {
  const maxAttempts = readNonNegativeInt(get, REDIS_STARTUP_ENV_KEYS.maxAttempts, DEFAULT_REDIS_STARTUP_RETRY.maxAttempts, 1);
  const initialDelayMs = readNonNegativeInt(get, REDIS_STARTUP_ENV_KEYS.initialDelayMs, DEFAULT_REDIS_STARTUP_RETRY.initialDelayMs, 0);
  const maxDelayMs = Math.max(
    initialDelayMs,
    readNonNegativeInt(get, REDIS_STARTUP_ENV_KEYS.maxDelayMs, DEFAULT_REDIS_STARTUP_RETRY.maxDelayMs, 0),
  );
  const attemptTimeoutMs = readNonNegativeInt(get, REDIS_STARTUP_ENV_KEYS.attemptTimeoutMs, DEFAULT_REDIS_STARTUP_RETRY.attemptTimeoutMs, 1);
  return { maxAttempts, initialDelayMs, maxDelayMs, attemptTimeoutMs };
}

/**
 * Parse host/port out of a connection URL without retaining any credentials.
 * Falls back to a best-effort result so an unusual URL shape can never leak
 * the raw value into an error message.
 */
export function parseRedisTarget(redisUrl: string | undefined): RedisTarget {
  if (redisUrl) {
    try {
      const parsed = new URL(redisUrl);
      const port = parsed.port
        ? Number(parsed.port)
        : parsed.protocol === 'rediss:'
          ? 6380
          : 6379;
      return { host: parsed.hostname || 'localhost', port };
    } catch {
      // Fall through to the sanitized default below.
    }
  }
  return { host: 'localhost', port: 6379 };
}

/** Exponential backoff with a cap and 50–100% jitter. */
export function computeBackoffDelay(
  attempt: number,
  options: RedisStartupRetryOptions,
  random: () => number,
): number {
  const exponential = options.initialDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, options.maxDelayMs);
  const jitter = 0.5 + random() * 0.5;
  return Math.max(0, Math.round(capped * jitter));
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function closeQuietly(client: RedisConnectable): void {
  try {
    client.disconnect?.(false);
  } catch {
    // Best effort: the client may already be closed.
  }
}

function connectOnce(
  client: RedisConnectable,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // A hung attempt must not hold the socket open across retries.
      closeQuietly(client);
      reject(new RedisAttemptTimeoutError(timeoutMs));
    }, timeoutMs);

    Promise.resolve()
      .then(() => client.connect())
      .then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

/**
 * Connect once, retrying with backoff until `options.maxAttempts` is reached.
 *
 * On success the promise resolves. On final failure the client is closed so no
 * connection or listener is leaked, and a RedisStartupConnectionError (with the
 * original error attached as `cause`) is thrown.
 */
export async function connectWithRetry(
  client: RedisConnectable,
  options: RedisStartupRetryOptions,
  target: RedisTarget,
  deps: ConnectRetryDeps,
  logger: ConnectRetryLogger,
): Promise<void> {
  const startedAt = deps.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      await connectOnce(client, options.attemptTimeoutMs);
      return;
    } catch (error) {
      lastError = error;
      const elapsedMs = Math.max(0, deps.now() - startedAt);
      const summary =
        `Redis connection attempt ${attempt}/${options.maxAttempts} to ` +
        `${target.host}:${target.port} failed after ${elapsedMs}ms: ${describeError(error)}`;

      if (attempt < options.maxAttempts) {
        const delay = computeBackoffDelay(attempt, options, deps.random);
        logger.warn(`${summary}. Retrying in ${delay}ms`);
        await deps.sleep(delay);
      } else {
        logger.warn(summary);
      }
    }
  }

  const elapsedMs = Math.max(0, deps.now() - startedAt);
  closeQuietly(client);
  throw new RedisStartupConnectionError(target, options.maxAttempts, elapsedMs, lastError);
}
