import { Logger } from '@nestjs/common';
import { ThrottlerStorageService } from './throttler-storage.service';

describe('ThrottlerStorageService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses Redis-backed storage for successful increments', async () => {
    const redis = {
      on: jest.fn(),
      eval: jest.fn().mockResolvedValue(3),
    };

    const service = new ThrottlerStorageService(redis as any);

    await expect(service.increment('throttle:test', 60_000, 60, 60, 'default')).resolves.toEqual({
      totalHits: 3,
      timeToExpire: 60_000,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call(\'INCR\''),
      1,
      'throttle:test',
      60,
    );
  });

  it('falls back to in-memory counts and warns when Redis increment fails', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const redis = {
      on: jest.fn(),
      eval: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    const service = new ThrottlerStorageService(redis as any);

    await expect(service.increment('throttle:fallback', 60_000, 60, 60, 'default')).resolves.toMatchObject({ totalHits: 1 });
    await expect(service.increment('throttle:fallback', 60_000, 60, 60, 'default')).resolves.toMatchObject({ totalHits: 2 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('in-memory fallback'));
  });

  it('logs Redis connection errors', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let errorListener: ((err: Error) => void) | undefined;
    const redis = {
      on: jest.fn((event: string, listener: (err: Error) => void) => {
        if (event === 'error') errorListener = listener;
      }),
      eval: jest.fn(),
    };

    new ThrottlerStorageService(redis as any);
    errorListener?.(new Error('bad REDIS_URL'));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad REDIS_URL'));
  });
});
