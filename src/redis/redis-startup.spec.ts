import {
  DEFAULT_REDIS_STARTUP_RETRY,
  RedisConnectable,
  RedisStartupConnectionError,
  RedisStartupRetryOptions,
  RedisAttemptTimeoutError,
  computeBackoffDelay,
  connectWithRetry,
  parseRedisTarget,
  readRedisStartupRetryOptions,
} from './redis-startup';

/** Fake ioredis-like client whose connect() fails a fixed number of times. */
class FakeRedisClient implements RedisConnectable {
  attempts = 0;
  disconnects = 0;
  status = 'wait';

  constructor(private readonly failuresBeforeSuccess: number) {}

  connect = jest.fn(async () => {
    this.attempts += 1;
    if (this.attempts <= this.failuresBeforeSuccess) {
      throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    }
    this.status = 'ready';
  });

  disconnect = jest.fn((_reconnect?: boolean) => {
    this.disconnects += 1;
    this.status = 'end';
  });
}

const options = (overrides: Partial<RedisStartupRetryOptions> = {}): RedisStartupRetryOptions => ({
  ...DEFAULT_REDIS_STARTUP_RETRY,
  ...overrides,
});

const target = { host: 'redis.internal', port: 6380 };

const deps = (random = () => 1) => ({
  sleep: jest.fn().mockResolvedValue(undefined),
  now: jest.fn(() => 1000),
  random,
});

const logger = { warn: jest.fn() };

describe('redis-startup helpers (#710)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('readRedisStartupRetryOptions', () => {
    it('returns the documented defaults when nothing is configured', () => {
      expect(readRedisStartupRetryOptions(() => undefined)).toEqual(DEFAULT_REDIS_STARTUP_RETRY);
    });

    it('honors configured values', () => {
      const env: Record<string, string> = {
        REDIS_STARTUP_MAX_ATTEMPTS: '9',
        REDIS_STARTUP_INITIAL_DELAY_MS: '50',
        REDIS_STARTUP_MAX_DELAY_MS: '5000',
        REDIS_STARTUP_ATTEMPT_TIMEOUT_MS: '750',
      };
      expect(readRedisStartupRetryOptions((key) => env[key])).toEqual({
        maxAttempts: 9,
        initialDelayMs: 50,
        maxDelayMs: 5000,
        attemptTimeoutMs: 750,
      });
    });

    it('ignores invalid values and falls back to defaults', () => {
      const env: Record<string, string> = {
        REDIS_STARTUP_MAX_ATTEMPTS: '0',
        REDIS_STARTUP_ATTEMPT_TIMEOUT_MS: 'abc',
      };
      const result = readRedisStartupRetryOptions((key) => env[key]);
      expect(result.maxAttempts).toBe(DEFAULT_REDIS_STARTUP_RETRY.maxAttempts);
      expect(result.attemptTimeoutMs).toBe(DEFAULT_REDIS_STARTUP_RETRY.attemptTimeoutMs);
    });
  });

  describe('parseRedisTarget', () => {
    it('extracts host and port', () => {
      expect(parseRedisTarget('redis://localhost:6379')).toEqual({ host: 'localhost', port: 6379 });
    });

    it('never retains credentials from the URL', () => {
      const parsed = parseRedisTarget('redis://admin:supersecret@redis.example.com:6380/1');
      expect(parsed).toEqual({ host: 'redis.example.com', port: 6380 });
      expect(JSON.stringify(parsed)).not.toContain('supersecret');
      expect(JSON.stringify(parsed)).not.toContain('admin');
    });

    it('falls back safely for unparseable URLs', () => {
      expect(parseRedisTarget('not a url')).toEqual({ host: 'localhost', port: 6379 });
      expect(parseRedisTarget(undefined)).toEqual({ host: 'localhost', port: 6379 });
    });
  });

  describe('computeBackoffDelay', () => {
    it('grows exponentially and is capped at maxDelayMs', () => {
      const opts = options({ initialDelayMs: 100, maxDelayMs: 400 });
      expect(computeBackoffDelay(1, opts, () => 1)).toBe(100);
      expect(computeBackoffDelay(2, opts, () => 1)).toBe(200);
      expect(computeBackoffDelay(3, opts, () => 1)).toBe(400);
      // 4th attempt would be 800ms but is capped at 400ms.
      expect(computeBackoffDelay(4, opts, () => 1)).toBe(400);
    });

    it('applies jitter between 50% and 100% of the capped delay', () => {
      const opts = options({ initialDelayMs: 100, maxDelayMs: 1000 });
      expect(computeBackoffDelay(1, opts, () => 0)).toBe(50);
      expect(computeBackoffDelay(1, opts, () => 1)).toBe(100);
    });
  });

  describe('RedisStartupConnectionError', () => {
    it('names host/port and attempt count, keeps the cause, and leaks no credentials', () => {
      const cause = new Error('connect ECONNREFUSED');
      const error = new RedisStartupConnectionError(
        { host: 'redis.internal', port: 6380 },
        5,
        1234,
        cause,
      );
      expect(error.message).toContain('redis.internal:6380');
      expect(error.message).toContain('5 attempt(s)');
      expect(error.message).toContain('1234ms');
      expect((error as { cause?: unknown }).cause).toBe(cause);
      expect(error.message).not.toContain('supersecret');
      expect(error.message).not.toContain('redis://');
    });
  });

  describe('connectWithRetry', () => {
    it('succeeds when Redis becomes available after failed attempts (slow startup)', async () => {
      const client = new FakeRedisClient(2);
      const d = deps();

      await connectWithRetry(client, options({ maxAttempts: 5 }), target, d, logger);

      expect(client.connect).toHaveBeenCalledTimes(3);
      expect(d.sleep).toHaveBeenCalledTimes(2);
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it('uses the configured max attempts and fails with one clear error', async () => {
      const client = new FakeRedisClient(Infinity);
      const d = deps();

      await expect(
        connectWithRetry(client, options({ maxAttempts: 3 }), target, d, logger),
      ).rejects.toBeInstanceOf(RedisStartupConnectionError);

      expect(client.connect).toHaveBeenCalledTimes(3);
      expect(d.sleep).toHaveBeenCalledTimes(2);
      // The failed client is closed so no connection/listener is leaked.
      expect(client.disconnect).toHaveBeenCalledTimes(1);
    });

    it('honors the configured backoff delays', async () => {
      const client = new FakeRedisClient(Infinity);
      const d = deps(() => 1);

      await expect(
        connectWithRetry(
          client,
          options({ maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 1000 }),
          target,
          d,
          logger,
        ),
      ).rejects.toBeInstanceOf(RedisStartupConnectionError);

      expect(d.sleep.mock.calls.map((call) => call[0])).toEqual([100, 200]);
    });

    it('gives up on a hung attempt once the per-attempt timeout elapses', async () => {
      jest.useFakeTimers();
      try {
        const client: RedisConnectable = {
          connect: jest.fn(() => new Promise(() => undefined)),
          disconnect: jest.fn(),
        };
        const d = deps();
        const promise = connectWithRetry(
          client,
          options({ maxAttempts: 1, attemptTimeoutMs: 50 }),
          target,
          d,
          logger,
        );
        const assertion = expect(promise).rejects.toBeInstanceOf(RedisStartupConnectionError);

        jest.advanceTimersByTime(60);
        await assertion;

        expect(client.disconnect).toHaveBeenCalledWith(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it('never leaks credentials through attempt logs', async () => {
      const client = new FakeRedisClient(Infinity);
      const d = deps();

      await expect(
        connectWithRetry(client, options({ maxAttempts: 1 }), target, d, logger),
      ).rejects.toBeInstanceOf(RedisStartupConnectionError);

      const logged = logger.warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).not.toContain('supersecret');
      expect(logged).not.toContain('redis://');
    });

    it('propagates an attempt timeout as the cause after exhausting attempts', async () => {
      jest.useFakeTimers();
      try {
        const client: RedisConnectable = {
          connect: jest.fn(() => new Promise(() => undefined)),
          disconnect: jest.fn(),
        };
        const promise = connectWithRetry(
          client,
          options({ maxAttempts: 1, attemptTimeoutMs: 25 }),
          target,
          deps(),
          logger,
        );
        const assertion = promise.catch((error: unknown) => error);

        jest.advanceTimersByTime(30);
        const error = (await assertion) as RedisStartupConnectionError;
        expect(error).toBeInstanceOf(RedisStartupConnectionError);
        expect((error as { cause?: unknown }).cause).toBeInstanceOf(RedisAttemptTimeoutError);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
