import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { DistributedLockService } from './distributed-lock.service';

describe('DistributedLockService coverage (#910)', () => {
  let redis: { set: jest.Mock; eval: jest.Mock };
  let service: DistributedLockService;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(() => {
    redis = { set: jest.fn(), eval: jest.fn() };
    service = new DistributedLockService(redis as unknown as Redis);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('acquire', () => {
    it('returns a token and uses SET ... PX ttl NX on success', async () => {
      redis.set.mockResolvedValue('OK');

      const token = await service.acquire('lock:a', 5000);

      expect(typeof token).toBe('string');
      expect(token).not.toBe('');
      expect(redis.set).toHaveBeenCalledWith('lock:a', token, 'PX', 5000, 'NX');
    });

    it('returns null on contention', async () => {
      redis.set.mockResolvedValue(null);

      await expect(service.acquire('lock:a', 5000)).resolves.toBeNull();
    });

    it('generates a different token for each acquisition', async () => {
      redis.set.mockResolvedValue('OK');

      const first = await service.acquire('lock:a', 5000);
      const second = await service.acquire('lock:a', 5000);

      expect(first).not.toBe(second);
    });

    it('returns null and logs an error when Redis throws', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      redis.set.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.acquire('lock:a', 5000)).resolves.toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Redis unreachable'));
    });
  });

  describe('release', () => {
    it('runs compare-and-delete with the key and token and returns true on match', async () => {
      redis.eval.mockResolvedValue(1);

      await expect(service.release('lock:a', 'tok-1')).resolves.toBe(true);
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining('DEL'),
        1,
        'lock:a',
        'tok-1',
      );
    });

    it('returns false when the stored token does not match', async () => {
      redis.eval.mockResolvedValue(0);

      await expect(service.release('lock:a', 'stale')).resolves.toBe(false);
    });

    it('returns false and logs a warning when Redis throws', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      redis.eval.mockRejectedValue(new Error('timeout'));

      await expect(service.release('lock:a', 'tok-1')).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Error releasing lock'));
    });
  });

  describe('renew', () => {
    it('runs PEXPIRE with the key, token and new TTL and returns true on match', async () => {
      redis.eval.mockResolvedValue(1);

      await expect(service.renew('lock:a', 'tok-1', 8000)).resolves.toBe(true);
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining('PEXPIRE'),
        1,
        'lock:a',
        'tok-1',
        8000,
      );
    });

    it('returns false when the stored token does not match', async () => {
      redis.eval.mockResolvedValue(0);

      await expect(service.renew('lock:a', 'stale', 8000)).resolves.toBe(false);
    });

    it('returns false and logs a warning when Redis throws', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      redis.eval.mockRejectedValue(new Error('timeout'));

      await expect(service.renew('lock:a', 'tok-1', 8000)).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Error renewing lock'));
    });
  });

  describe('runWithLock lifecycle', () => {
    it('runs the task under the lock, returns its result and releases afterwards', async () => {
      redis.set.mockResolvedValue('OK');
      redis.eval.mockResolvedValue(1);
      const task = jest.fn().mockResolvedValue(42);

      const outcome = await service.runWithLock('lock:a', 9000, task);

      expect(outcome).toEqual({ executed: true, result: 42 });
      expect(task).toHaveBeenCalledTimes(1);
      const token = redis.set.mock.calls[0][1];
      expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining('DEL'), 1, 'lock:a', token);
    });

    it('skips the task and does not touch the lock when it is already held', async () => {
      redis.set.mockResolvedValue(null);
      const task = jest.fn();

      await expect(service.runWithLock('lock:a', 9000, task)).resolves.toEqual({
        executed: false,
      });
      expect(task).not.toHaveBeenCalled();
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('releases the lock and rethrows when the task fails', async () => {
      redis.set.mockResolvedValue('OK');
      redis.eval.mockResolvedValue(1);
      const task = jest.fn().mockRejectedValue(new Error('boom'));

      await expect(service.runWithLock('lock:a', 9000, task)).rejects.toThrow('boom');
      const token = redis.set.mock.calls[0][1];
      expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining('DEL'), 1, 'lock:a', token);
    });

    it('clears the heartbeat timer once the task completes', async () => {
      redis.set.mockResolvedValue('OK');
      redis.eval.mockResolvedValue(1);
      const renewSpy = jest.spyOn(service, 'renew');

      const outcome = await service.runWithLock(
        'lock:a',
        3000,
        () => sleep(80).then(() => 'done'),
        { extendIntervalMs: 20 },
      );
      expect(outcome.executed).toBe(true);

      const callsAtCompletion = renewSpy.mock.calls.length;
      expect(callsAtCompletion).toBeGreaterThanOrEqual(1);

      await sleep(80);
      expect(renewSpy.mock.calls.length).toBe(callsAtCompletion);
    });

    it('does not renew the lock when the heartbeat is disabled', async () => {
      redis.set.mockResolvedValue('OK');
      redis.eval.mockResolvedValue(1);
      const renewSpy = jest.spyOn(service, 'renew');

      await service.runWithLock('lock:a', 3000, () => sleep(80), {
        enableHeartbeat: false,
        extendIntervalMs: 20,
      });

      expect(renewSpy).not.toHaveBeenCalled();
    });

    it('logs a warning but still completes the task when a heartbeat renewal fails', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      redis.set.mockResolvedValue('OK');
      redis.eval.mockImplementation(async (script: string) =>
        script.includes('PEXPIRE') ? 0 : 1,
      );

      const outcome = await service.runWithLock('lock:a', 3000, () => sleep(80).then(() => 'ok'), {
        extendIntervalMs: 20,
      });

      expect(outcome).toEqual({ executed: true, result: 'ok' });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Watchdog heartbeat failed'));
    });
  });
});