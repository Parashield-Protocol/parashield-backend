import { Test, TestingModule } from '@nestjs/testing';
import { PolicyStateCacheService, POLICY_DERIVED_STATE_TTL_SECONDS } from './policy-state-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { OracleService } from '../oracle/oracle.service';
import { PolicyStatus, ClaimStatus } from '@prisma/client';
import { StatusEventsService } from '../common/events/status-events.service';

describe('PolicyStateCacheService (#714)', () => {
  let service: PolicyStateCacheService;
  let mockPrisma: any;
  let mockOracle: any;
  let mockRedis: any;
  let mockStatusEvents: any;

  const mockPolicy = {
    id: 'policy-uuid-1',
    policyholder: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    productId: 'product-uuid-1',
    coverageXlm: BigInt(500000000), // 50 XLM in stroops
    premiumPaid: BigInt(25000000),  // 2.5 XLM
    oracleKey: 'rainfall:station-101:monthly',
    status: PolicyStatus.ACTIVE,
    startTime: new Date('2026-01-01T00:00:00.000Z'),
    endTime: new Date('2026-06-01T00:00:00.000Z'),
    product: {
      id: 'product-uuid-1',
      name: 'Drought Cover',
      category: 'weather',
      triggerType: 'cumulative_rainfall',
      threshold: '50.0',
      comparison: 'LessThan',
      status: 'ACTIVE',
    },
    claims: [],
  };

  const mockReading = {
    id: 'reading-1',
    key: 'rainfall:station-101:monthly',
    value: BigInt(450000000), // 45.0 in stroops
    bucketStart: new Date('2026-05-01T00:00:00.000Z'),
  };

  beforeEach(async () => {
    mockPrisma = {
      policy: {
        // structuredClone (not JSON round-trip) so BigInt/Date fields survive.
        findUnique: jest.fn().mockResolvedValue(structuredClone(mockPolicy)),
        findMany: jest.fn().mockResolvedValue([{ id: 'policy-uuid-1' }]),
      },
    };

    mockOracle = {
      getLatestReading: jest.fn().mockResolvedValue({ ...mockReading }),
    };

    const redisStore = new Map<string, string>();
    mockRedis = {
      get: jest.fn().mockImplementation(async (key: string) => redisStore.get(key) ?? null),
      set: jest.fn().mockImplementation(async (key: string, val: string) => {
        redisStore.set(key, val);
        return 'OK';
      }),
      del: jest.fn().mockImplementation(async (...keys: string[]) => {
        keys.forEach((k) => redisStore.delete(k));
        return keys.length;
      }),
      keys: jest.fn().mockImplementation(async () => Array.from(redisStore.keys())),
      publish: jest.fn().mockResolvedValue(1),
      duplicate: jest.fn().mockReturnValue({
        on: jest.fn(),
        subscribe: jest.fn().mockResolvedValue(1),
        unsubscribe: jest.fn().mockResolvedValue(1),
        disconnect: jest.fn(),
      }),
    };

    mockStatusEvents = {
      onStatusChange: jest.fn(),
      onOracleKeyChange: jest.fn(),
      onProductUpdate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PolicyStateCacheService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OracleService, useValue: mockOracle },
        { provide: 'REDIS_CLIENT', useValue: mockRedis },
        { provide: StatusEventsService, useValue: mockStatusEvents },
      ],
    }).compile();

    service = module.get<PolicyStateCacheService>(PolicyStateCacheService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('1. Repeated checks compute once', () => {
    it('computes on the first check and serves subsequent checks from cache', async () => {
      const now = new Date('2026-02-01T00:00:00.000Z');

      // First check (miss)
      const first = await service.getDerivedPolicyState('policy-uuid-1', now);
      expect(first).toBeDefined();
      expect(first?.policyId).toBe('policy-uuid-1');
      expect(first?.effectiveStatus).toBe(PolicyStatus.ACTIVE);
      expect(mockPrisma.policy.findUnique).toHaveBeenCalledTimes(1);
      expect(mockOracle.getLatestReading).toHaveBeenCalledTimes(1);

      // Repeated checks (hits)
      for (let i = 0; i < 10; i++) {
        const cached = await service.getDerivedPolicyState('policy-uuid-1', now);
        expect(cached?.policyId).toBe('policy-uuid-1');
      }

      // No additional DB or Oracle calls
      expect(mockPrisma.policy.findUnique).toHaveBeenCalledTimes(1);
      expect(mockOracle.getLatestReading).toHaveBeenCalledTimes(1);
      expect(service.metrics.computations).toBe(1);
      expect(service.metrics.hits).toBe(10);
      expect(service.metrics.misses).toBe(1);
    });
  });

  describe('2. Policy update invalidates cache', () => {
    it('recomputes policy state after invalidation and reflects the changes', async () => {
      const now = new Date('2026-02-01T00:00:00.000Z');

      // Initial check
      await service.getDerivedPolicyState('policy-uuid-1', now);
      expect(service.metrics.computations).toBe(1);

      // Policy is updated (e.g. oracle key change)
      mockPrisma.policy.findUnique.mockResolvedValueOnce({
        ...mockPolicy,
        oracleKey: 'rainfall:station-999:monthly',
      });

      // Invalidate cache
      await service.invalidate('policy-uuid-1');
      expect(service.metrics.invalidations).toBe(1);

      // Next check must recompute
      const updated = await service.getDerivedPolicyState('policy-uuid-1', now);
      expect(updated?.oracleKey).toBe('rainfall:station-999:monthly');
      expect(service.metrics.computations).toBe(2);
      expect(mockPrisma.policy.findUnique).toHaveBeenCalledTimes(2);
    });
  });

  describe('3. Claim change invalidates cache', () => {
    it('recomputes policy state when claim is created or changed', async () => {
      const now = new Date('2026-02-01T00:00:00.000Z');

      // Initial check (no claims)
      const initial = await service.getDerivedPolicyState('policy-uuid-1', now);
      expect(initial?.claimsCount).toBe(0);
      expect(initial?.hasInFlightClaim).toBe(false);

      // Claim submitted: policy updated with a processing claim
      mockPrisma.policy.findUnique.mockResolvedValueOnce({
        ...mockPolicy,
        claims: [
          {
            id: 'claim-101',
            status: ClaimStatus.PROCESSING,
          },
        ],
      });

      // Invalidate cache
      await service.invalidate('policy-uuid-1');

      // Next check reflects updated claims
      const recomputed = await service.getDerivedPolicyState('policy-uuid-1', now);
      expect(recomputed?.claimsCount).toBe(1);
      expect(recomputed?.hasInFlightClaim).toBe(true);
      expect(recomputed?.activeClaimId).toBe('claim-101');
      expect(service.metrics.computations).toBe(2);
    });
  });

  describe('4. TTL expiry path', () => {
    it('expires cached entries after TTL and recomputes', async () => {
      const startTime = new Date('2026-02-01T00:00:00.000Z');

      // First check caches entry
      await service.getDerivedPolicyState('policy-uuid-1', startTime);
      expect(service.metrics.computations).toBe(1);

      // Simulate TTL expiration: advance past TTL window
      const realDateNow = Date.now;
      try {
        Date.now = jest.fn(() => realDateNow() + (POLICY_DERIVED_STATE_TTL_SECONDS + 5) * 1000);
        // Clear Redis to test L1 memory TTL expiry
        await mockRedis.del('cache:policy:derived:policy-uuid-1');

        // Next check should recompute
        await service.getDerivedPolicyState('policy-uuid-1', startTime);
        expect(service.metrics.computations).toBe(2);
      } finally {
        Date.now = realDateNow;
      }
    });
  });

  describe('5. Stampede protection (single-flight concurrent misses)', () => {
    it('coalesces concurrent requests during a cache miss into a single computation', async () => {
      // Introduce an async delay to simulate network/DB latency
      mockPrisma.policy.findUnique.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { ...mockPolicy };
      });

      const now = new Date('2026-02-01T00:00:00.000Z');

      // Fire 10 concurrent requests simultaneously
      const results = await Promise.all(
        Array.from({ length: 10 }).map(() => service.getDerivedPolicyState('policy-uuid-1', now)),
      );

      // All 10 requests should resolve successfully with identical state
      expect(results.length).toBe(10);
      for (const res of results) {
        expect(res?.policyId).toBe('policy-uuid-1');
      }

      // Exactly ONE computation should have executed
      expect(service.metrics.computations).toBe(1);
      expect(mockPrisma.policy.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('6. Dynamic time evaluation across expiry boundary', () => {
    it('evaluates isExpired dynamically without relying on stale cached values', async () => {
      const endTime = new Date('2026-06-01T00:00:00.000Z');

      // Check before expiry
      const beforeExpiry = new Date('2026-05-31T23:59:59.000Z');
      const stateBefore = await service.getDerivedPolicyState('policy-uuid-1', beforeExpiry);
      expect(stateBefore?.isExpired).toBe(false);
      expect(stateBefore?.effectiveStatus).toBe(PolicyStatus.ACTIVE);

      // Check after expiry (1 second later): without invalidating cache!
      const afterExpiry = new Date('2026-06-01T00:00:01.000Z');
      const stateAfter = await service.getDerivedPolicyState('policy-uuid-1', afterExpiry);

      // State is instantly EXPIRED even though entry is cached from before
      expect(stateAfter?.isExpired).toBe(true);
      expect(stateAfter?.effectiveStatus).toBe(PolicyStatus.EXPIRED);
      // Still only 1 computation from the DB
      expect(service.metrics.computations).toBe(1);
    });
  });

  describe('7. Never caches failed computations', () => {
    it('does not cache when computation throws an error', async () => {
      mockPrisma.policy.findUnique.mockRejectedValueOnce(new Error('DB connection reset'));

      await expect(service.getDerivedPolicyState('policy-uuid-1')).rejects.toThrow('DB connection reset');

      // Next attempt succeeds
      mockPrisma.policy.findUnique.mockResolvedValueOnce({ ...mockPolicy });
      const recovered = await service.getDerivedPolicyState('policy-uuid-1');
      expect(recovered?.policyId).toBe('policy-uuid-1');
      expect(service.metrics.computations).toBe(2);
    });
  });

  describe('8. Benchmark: N consecutive status checks before vs after caching', () => {
    it('measures honest DB query and computation counts for N=20 status checks', async () => {
      const N = 20;
      const now = new Date('2026-02-01T00:00:00.000Z');

      // BEFORE caching (simulating raw uncached computation on every call):
      let uncachedDbQueries = 0;
      let uncachedComputations = 0;
      for (let i = 0; i < N; i++) {
        uncachedComputations++;
        uncachedDbQueries += 2; // findUnique policy + getLatestReading
        await mockPrisma.policy.findUnique({ where: { id: 'policy-uuid-1' } });
        await mockOracle.getLatestReading(mockPolicy.oracleKey);
      }

      // Reset service metrics
      service.resetMetrics();
      jest.clearAllMocks();

      // AFTER caching (using PolicyStateCacheService):
      for (let i = 0; i < N; i++) {
        await service.getDerivedPolicyState('policy-uuid-1', now);
      }

      const cachedComputations = service.metrics.computations;
      const cachedDbQueries = service.metrics.dbQueries;
      const cacheHits = service.metrics.hits;
      const cacheMisses = service.metrics.misses;

      // Honest verification:
      expect(uncachedComputations).toBe(20);
      expect(uncachedDbQueries).toBe(40);

      expect(cachedComputations).toBe(1);
      expect(cachedDbQueries).toBe(2);
      expect(cacheHits).toBe(19);
      expect(cacheMisses).toBe(1);

      // Computation reduction: (20 - 1) / 20 = 95%
      const computationReductionPct = ((uncachedComputations - cachedComputations) / uncachedComputations) * 100;
      expect(computationReductionPct).toBe(95);

      // DB query reduction: (40 - 2) / 40 = 95%
      const dbQueryReductionPct = ((uncachedDbQueries - cachedDbQueries) / uncachedDbQueries) * 100;
      expect(dbQueryReductionPct).toBe(95);
    });
  });

  describe('#712 — exact oracle threshold comparison', () => {
    it('does not trigger when the reading equals the threshold', async () => {
      mockOracle.getLatestReading.mockResolvedValue({
        ...mockReading,
        value: BigInt(500_000_000), // exactly 50.0, equal to the '50.0' threshold
      });

      const state = await service.computePolicyState('policy-uuid-1');

      expect(state?.triggerMet).toBe(false);
      expect(state?.latestReadingValue).toBe('500000000');
    });

    it('triggers when the reading is one unit below a LessThan threshold', async () => {
      mockOracle.getLatestReading.mockResolvedValue({
        ...mockReading,
        value: BigInt(499_999_999), // 49.9999999 < 50.0
      });

      const state = await service.computePolicyState('policy-uuid-1');

      expect(state?.triggerMet).toBe(true);
    });

    it('falls back to the reading timestamp when bucketStart is absent', async () => {
      mockOracle.getLatestReading.mockResolvedValue({
        key: 'rainfall:station-101:monthly',
        value: '450000000',
        confidence: 90,
        timestamp: 1_700_000_000,
        source: 'open-meteo',
      });

      const state = await service.computePolicyState('policy-uuid-1');

      expect(state?.latestReadingTimestamp).toBe(1_700_000_000_000);
      expect(state?.triggerMet).toBe(true);
    });
  });
});
