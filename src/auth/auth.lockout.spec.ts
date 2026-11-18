import {
  AuthController,
  computeLockoutDurationSeconds,
  LOCKOUT_LEVEL_DECAY_SECONDS,
  MAX_LOCKOUT_DURATION_SECONDS,
} from './auth.controller';

/**
 * #814 — lockouts grow exponentially per wallet, so waiting out one window
 * no longer hands an attacker a fresh batch of attempts at the same rate.
 */
describe('progressive login lockout (#814)', () => {
  describe('computeLockoutDurationSeconds', () => {
    it('doubles the base duration for each lockout level', () => {
      expect(computeLockoutDurationSeconds(900, 1)).toBe(900);
      expect(computeLockoutDurationSeconds(900, 2)).toBe(1800);
      expect(computeLockoutDurationSeconds(900, 3)).toBe(3600);
      expect(computeLockoutDurationSeconds(900, 4)).toBe(7200);
    });

    it('caps at MAX_LOCKOUT_DURATION_SECONDS', () => {
      expect(computeLockoutDurationSeconds(900, 50)).toBe(MAX_LOCKOUT_DURATION_SECONDS);
    });

    it('falls back to a sane base for an invalid configured value', () => {
      expect(computeLockoutDurationSeconds(Number.NaN, 1)).toBe(900);
      expect(computeLockoutDurationSeconds(-5, 2)).toBe(1800);
    });
  });

  describe('recordFailedLogin', () => {
    const WALLET = 'GTESTWALLET';
    let store: Map<string, { value: number; ttl?: number }>;
    let redis: any;
    let controller: AuthController;

    const record = () => (controller as any).recordFailedLogin(WALLET, 5, 900);

    beforeEach(() => {
      store = new Map();
      redis = {
        incr: jest.fn(async (key: string) => {
          const item = store.get(key) ?? { value: 0 };
          item.value += 1;
          store.set(key, item);
          return item.value;
        }),
        expire: jest.fn(async (key: string, ttl: number) => {
          const item = store.get(key);
          if (item) item.ttl = ttl;
          return item ? 1 : 0;
        }),
      };
      controller = new AuthController({} as any, {} as any, redis, {} as any);
    });

    it('locks for the base duration the first time the threshold is reached', async () => {
      for (let i = 0; i < 5; i++) await record();

      expect(store.get(`auth:lockout:${WALLET}`)?.ttl).toBe(900);
      expect(store.get(`auth:lockout-level:${WALLET}`)?.value).toBe(1);
      expect(store.get(`auth:lockout-level:${WALLET}`)?.ttl).toBe(LOCKOUT_LEVEL_DECAY_SECONDS);
    });

    it('doubles the lockout after the previous one has expired', async () => {
      for (let i = 0; i < 5; i++) await record();
      // The first lockout window expires: the failure counter is gone, but
      // the lockout level survives.
      store.delete(`auth:lockout:${WALLET}`);
      for (let i = 0; i < 5; i++) await record();

      expect(store.get(`auth:lockout-level:${WALLET}`)?.value).toBe(2);
      expect(store.get(`auth:lockout:${WALLET}`)?.ttl).toBe(1800);
    });

    it('does not throw when Redis fails', async () => {
      redis.incr.mockRejectedValueOnce(new Error('redis down'));
      await expect(record()).resolves.toBeUndefined();
    });
  });
});
