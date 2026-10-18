import { DistributedLockService } from './distributed-lock.service';
import type Redis from 'ioredis';

describe('DistributedLockService', () => {
  // Faithful in-memory Redis simulation supporting SET NX PX, GET, DEL, PEXPIRE, and Lua eval
  class FakeRedis {
    private store = new Map<string, { value: string; expiresAt: number }>();
    public failMode = false;

    async set(key: string, value: string, px?: string, ttlMs?: number, nx?: string): Promise<string | null> {
      if (this.failMode) throw new Error('Redis connection failed');
      const now = Date.now();
      const current = this.store.get(key);
      if (current && current.expiresAt > now && nx === 'NX') {
        return null; // Key exists and has not expired
      }
      const expiresAt = ttlMs ? now + ttlMs : Infinity;
      this.store.set(key, { value, expiresAt });
      return 'OK';
    }

    async get(key: string): Promise<string | null> {
      if (this.failMode) throw new Error('Redis connection failed');
      const now = Date.now();
      const current = this.store.get(key);
      if (!current) return null;
      if (current.expiresAt <= now) {
        this.store.delete(key);
        return null;
      }
      return current.value;
    }

    async del(key: string): Promise<number> {
      if (this.failMode) throw new Error('Redis connection failed');
      return this.store.delete(key) ? 1 : 0;
    }

    async eval(script: string, numKeys: number, key: string, ...args: any[]): Promise<number> {
      if (this.failMode) throw new Error('Redis connection failed');
      const now = Date.now();
      const current = this.store.get(key);
      const isExpired = current ? current.expiresAt <= now : true;
      if (isExpired && current) this.store.delete(key);

      const currentValue = isExpired ? null : current!.value;
      const targetToken = args[0];

      // Compare-and-delete Lua script simulation
      if (script.includes('DEL')) {
        if (currentValue === targetToken) {
          this.store.delete(key);
          return 1;
        }
        return 0;
      }

      // Renew (PEXPIRE) Lua script simulation
      if (script.includes('PEXPIRE')) {
        if (currentValue === targetToken) {
          const newTtlMs = Number(args[1]);
          this.store.set(key, { value: currentValue, expiresAt: now + newTtlMs });
          return 1;
        }
        return 0;
      }

      return 0;
    }

    clear() {
      this.store.clear();
      this.failMode = false;
    }
  }

  let fakeRedis: FakeRedis;
  let lockService: DistributedLockService;

  beforeEach(() => {
    fakeRedis = new FakeRedis();
    lockService = new DistributedLockService(fakeRedis as unknown as Redis);
  });

  describe('Distributed locking semantics', () => {
    it('only one of two concurrent runners executes, and the second skips', async () => {
      let executionCount = 0;
      const job = jest.fn(async () => {
        executionCount++;
        // Small delay to simulate work
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'success';
      });

      // Launch two concurrent runs
      const [run1, run2] = await Promise.all([
        lockService.runWithLock('lock:test:concurrent', 10000, job),
        lockService.runWithLock('lock:test:concurrent', 10000, job),
      ]);

      const executedRuns = [run1, run2].filter((r) => r.executed);
      const skippedRuns = [run1, run2].filter((r) => !r.executed);

      expect(executedRuns).toHaveLength(1);
      expect(skippedRuns).toHaveLength(1);
      expect(executionCount).toBe(1);
      expect(job).toHaveBeenCalledTimes(1);
    });

    it('the lock is released after successful execution', async () => {
      const task = jest.fn(async () => 'done');

      const firstRun = await lockService.runWithLock('lock:test:release-success', 10000, task);
      expect(firstRun.executed).toBe(true);

      // Lock should now be free, second acquire succeeds
      const token = await lockService.acquire('lock:test:release-success', 10000);
      expect(token).not.toBeNull();
      await lockService.release('lock:test:release-success', token!);
    });

    it('the lock is released after failure', async () => {
      const failingTask = jest.fn(async () => {
        throw new Error('Task failed unexpectedly');
      });

      await expect(
        lockService.runWithLock('lock:test:release-failure', 10000, failingTask),
      ).rejects.toThrow('Task failed unexpectedly');

      // Lock should be released in finally block despite the exception
      const token = await lockService.acquire('lock:test:release-failure', 10000);
      expect(token).not.toBeNull();
      await lockService.release('lock:test:release-failure', token!);
    });

    it('the lock expires if the holder dies (TTL expiration)', async () => {
      jest.useFakeTimers();
      try {
        const token = await lockService.acquire('lock:test:ttl', 1000);
        expect(token).not.toBeNull();

        // Second acquisition immediately fails
        const secondAcquire = await lockService.acquire('lock:test:ttl', 1000);
        expect(secondAcquire).toBeNull();

        // Simulate holder crashing and time elapsing past TTL (1001ms)
        jest.advanceTimersByTime(1001);

        // Another instance should now acquire successfully
        const thirdAcquire = await lockService.acquire('lock:test:ttl', 1000);
        expect(thirdAcquire).not.toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('a stale holder cannot release a newer holder\'s lock', async () => {
      jest.useFakeTimers();
      try {
        // Holder 1 acquires with token1
        const token1 = await lockService.acquire('lock:test:stale', 1000);
        expect(token1).not.toBeNull();

        // Lock expires naturally for holder 1
        jest.advanceTimersByTime(1500);

        // Holder 2 acquires with token2
        const token2 = await lockService.acquire('lock:test:stale', 5000);
        expect(token2).not.toBeNull();
        expect(token2).not.toEqual(token1);

        // Stale holder 1 attempts to release with token1
        const releasedByStale = await lockService.release('lock:test:stale', token1!);
        expect(releasedByStale).toBe(false);

        // Holder 2's lock must still be active in Redis
        const remainingHolderToken = await fakeRedis.get('lock:test:stale');
        expect(remainingHolderToken).toBe(token2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('multi-instance case: two separate lock-client instances against the same Redis store', async () => {
      // Two distinct service instances simulating two application replicas
      const instanceA = new DistributedLockService(fakeRedis as unknown as Redis);
      const instanceB = new DistributedLockService(fakeRedis as unknown as Redis);

      // Instance A acquires
      const tokenA = await instanceA.acquire('lock:cluster:job', 5000);
      expect(tokenA).not.toBeNull();

      // Instance B attempts to acquire same key, fails
      const tokenB = await instanceB.acquire('lock:cluster:job', 5000);
      expect(tokenB).toBeNull();

      // Instance A releases
      const released = await instanceA.release('lock:cluster:job', tokenA!);
      expect(released).toBe(true);

      // Instance B now acquires successfully
      const tokenB2 = await instanceB.acquire('lock:cluster:job', 5000);
      expect(tokenB2).not.toBeNull();

      await instanceB.release('lock:cluster:job', tokenB2!);
    });

    it('when Redis is unreachable, skips execution and logs error loudly', async () => {
      fakeRedis.failMode = true; // Simulate Redis outage

      const task = jest.fn();
      const result = await lockService.runWithLock('lock:test:outage', 5000, task);

      expect(result.executed).toBe(false);
      expect(task).not.toHaveBeenCalled();
    });

    it('watchdog heartbeat extends the lock for long-running jobs', async () => {
      jest.useFakeTimers();
      try {
        const renewSpy = jest.spyOn(lockService, 'renew');

        let completeTask: () => void = () => {};
        const longRunningPromise = new Promise<string>((resolve) => {
          completeTask = () => resolve('finished');
        });

        const executionPromise = lockService.runWithLock(
          'lock:test:heartbeat',
          3000,
          () => longRunningPromise,
          { enableHeartbeat: true, extendIntervalMs: 1000 },
        );

        // Advance timers by 1000ms -> heartbeat fires
        jest.advanceTimersByTime(1000);
        expect(renewSpy).toHaveBeenCalledTimes(1);

        // Advance timers by another 1000ms -> heartbeat fires again
        jest.advanceTimersByTime(1000);
        expect(renewSpy).toHaveBeenCalledTimes(2);

        // Complete the task
        completeTask();
        await executionPromise;
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
