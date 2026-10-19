import { Injectable, Inject, Optional, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { OracleService } from '../oracle/oracle.service';
import { PolicyStatus, ClaimStatus } from '@prisma/client';
import { StatusEventsService, PolicyStatusEvent, PolicyOracleKeyChangeEvent } from '../common/events/status-events.service';
import { compareScaledToThreshold, parseDecimalScaled, parseFixedPointBigInt } from '../common/utils/decimal';

export const POLICY_DERIVED_STATE_TTL_SECONDS = 60;
const IN_MEMORY_MAX_ENTRIES = 2000;
const INVALIDATION_CHANNEL = 'cache:policy:invalidate';

/**
 * Time-independent state cached in Redis / memory (#714).
 * Storing the expiry boundary (`endTime`) separately from time-dependent
 * evaluation prevents stale data across boundary transitions.
 */
export interface TimeIndependentPolicyState {
  policyId: string;
  policyholder: string;
  productId: string;
  productName: string;
  coverageXlm: string;
  premiumPaid: string;
  oracleKey: string;
  rawStatus: PolicyStatus;
  startTime: number; // epoch ms
  endTime: number;   // epoch ms boundary
  threshold: string;
  comparison: string;
  latestReadingValue: string | null;
  latestReadingTimestamp: number | null;
  triggerMet: boolean;
  claimsCount: number;
  hasPaidClaim: boolean;
  hasInFlightClaim: boolean;
  activeClaimId: string | null;
  activeClaimStatus: ClaimStatus | null;
  cachedAt: number;
}

/**
 * Derived policy state with dynamic time evaluation (#714).
 */
export interface DerivedPolicyState extends TimeIndependentPolicyState {
  isExpired: boolean;
  isPendingFinalPeriod: boolean;
  effectiveStatus: PolicyStatus;
  canClaim: boolean;
  evaluationTimestamp: number;
}

/**
 * Cache metrics for benchmarking and performance tracking (#714).
 */
export interface CacheMetrics {
  hits: number;
  misses: number;
  computations: number;
  invalidations: number;
  dbQueries: number;
}

@Injectable()
export class PolicyStateCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PolicyStateCacheService.name);
  private readonly memoryCache = new Map<string, { state: TimeIndependentPolicyState; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<TimeIndependentPolicyState>>();
  private subscriber?: Redis;

  public readonly metrics: CacheMetrics = {
    hits: 0,
    misses: 0,
    computations: 0,
    invalidations: 0,
    dbQueries: 0,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly oracleService: OracleService,
    @Optional()
    @Inject('REDIS_CLIENT')
    private readonly redis?: Redis,
    @Optional()
    private readonly statusEvents?: StatusEventsService,
  ) {}

  private getRedisKey(policyId: string): string {
    return `cache:policy:derived:${policyId}`;
  }

  async onModuleInit(): Promise<void> {
    // 1. Subscribe to StatusEventsService if available
    if (this.statusEvents && typeof this.statusEvents.onStatusChange === 'function') {
      this.statusEvents.onStatusChange((event: PolicyStatusEvent) => {
        if (event?.policyId) {
          this.invalidateMemoryOnly(event.policyId);
        }
      });
    }

    if (this.statusEvents && typeof this.statusEvents.onOracleKeyChange === 'function') {
      this.statusEvents.onOracleKeyChange((event: PolicyOracleKeyChangeEvent) => {
        if (event?.policyId) {
          this.invalidateMemoryOnly(event.policyId);
        }
      });
    }

    if (this.statusEvents && typeof this.statusEvents.onProductUpdate === 'function') {
      this.statusEvents.onProductUpdate(() => {
        this.memoryCache.clear();
        this.inFlight.clear();
      });
    }

    // 2. Multi-instance cross-process cache invalidation via Redis pub/sub (#714)
    if (this.redis && typeof this.redis.duplicate === 'function') {
      try {
        this.subscriber = this.redis.duplicate();
        this.subscriber.on('error', (err) => {
          this.logger.warn(`Redis cache subscriber error: ${(err as Error).message}`);
        });
        this.subscriber.on('message', (channel, message) => {
          if (channel === INVALIDATION_CHANNEL) {
            try {
              const data = JSON.parse(message);
              if (data.all) {
                this.memoryCache.clear();
                this.inFlight.clear();
              } else if (data.policyId) {
                this.invalidateMemoryOnly(data.policyId);
              }
            } catch (err) {
              this.logger.warn(`Invalid cache invalidation message: ${(err as Error).message}`);
            }
          }
        });
        await this.subscriber.subscribe(INVALIDATION_CHANNEL);
      } catch (err) {
        this.logger.warn(`Failed to subscribe to Redis cache invalidation channel: ${(err as Error).message}`);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subscriber) {
      try {
        if (typeof this.subscriber.unsubscribe === 'function') {
          await this.subscriber.unsubscribe(INVALIDATION_CHANNEL);
        }
        if (typeof this.subscriber.disconnect === 'function') {
          this.subscriber.disconnect();
        }
      } catch (err) {
        this.logger.warn(`Error disconnecting Redis cache subscriber: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Reset metrics for testing or benchmarking.
   */
  resetMetrics(): void {
    this.metrics.hits = 0;
    this.metrics.misses = 0;
    this.metrics.computations = 0;
    this.metrics.invalidations = 0;
    this.metrics.dbQueries = 0;
  }

  /**
   * Evaluate dynamic time-dependent fields from the cached time-independent state.
   */
  public applyTimeEvaluation(state: TimeIndependentPolicyState, nowMs = Date.now()): DerivedPolicyState {
    const isExpired = nowMs > state.endTime;
    const isPendingFinalPeriod = nowMs < state.endTime;

    let effectiveStatus = state.rawStatus;
    if (state.rawStatus === PolicyStatus.ACTIVE && isExpired) {
      effectiveStatus = PolicyStatus.EXPIRED;
    }

    const canClaim =
      effectiveStatus === PolicyStatus.ACTIVE &&
      state.triggerMet &&
      !state.hasPaidClaim &&
      !state.hasInFlightClaim &&
      nowMs >= state.endTime;

    return {
      ...state,
      isExpired,
      isPendingFinalPeriod,
      effectiveStatus,
      canClaim,
      evaluationTimestamp: nowMs,
    };
  }

  /**
   * Retrieve cached state or compute derived policy state.
   *
   * Utilizes in-flight promise sharing (single-flight) to prevent cache stampedes.
   * Never caches failed computations.
   */
  async getDerivedPolicyState(policyId: string, now: Date = new Date()): Promise<DerivedPolicyState | null> {
    const nowMs = now.getTime();

    // 1. Check in-flight computation (stampede protection)
    if (this.inFlight.has(policyId)) {
      this.metrics.hits++;
      const inFlightState = await this.inFlight.get(policyId)!;
      return this.applyTimeEvaluation(inFlightState, nowMs);
    }

    // 2. Check in-memory L1 cache
    const inMem = this.memoryCache.get(policyId);
    if (inMem && inMem.expiresAt > Date.now()) {
      this.metrics.hits++;
      return this.applyTimeEvaluation(inMem.state, nowMs);
    }

    // 3. Check Redis L2 cache if available
    if (this.redis && typeof this.redis.get === 'function') {
      try {
        const raw = await this.redis.get(this.getRedisKey(policyId));
        if (raw) {
          const state = JSON.parse(raw) as TimeIndependentPolicyState;
          this.memoryCache.set(policyId, {
            state,
            expiresAt: Date.now() + POLICY_DERIVED_STATE_TTL_SECONDS * 1000,
          });
          this.metrics.hits++;
          return this.applyTimeEvaluation(state, nowMs);
        }
      } catch (err) {
        this.logger.warn(`Redis cache get error for policy ${policyId}: ${(err as Error).message}`);
      }
    }

    // 4. Cache miss: trigger computation with singleflight in-flight sharing
    this.metrics.misses++;

    const computationPromise = this.computePolicyState(policyId);
    this.inFlight.set(policyId, computationPromise);

    try {
      const state = await computationPromise;
      if (!state) return null;

      // Cache time-independent state in memory
      if (this.memoryCache.size >= IN_MEMORY_MAX_ENTRIES) {
        this.memoryCache.clear();
      }
      this.memoryCache.set(policyId, {
        state,
        expiresAt: Date.now() + POLICY_DERIVED_STATE_TTL_SECONDS * 1000,
      });

      // Cache time-independent state in Redis
      if (this.redis && typeof this.redis.set === 'function') {
        const payload = JSON.stringify(state);
        this.redis
          .set(this.getRedisKey(policyId), payload, 'EX', POLICY_DERIVED_STATE_TTL_SECONDS)
          .catch((err) => {
            this.logger.warn(`Redis cache set error for policy ${policyId}: ${(err as Error).message}`);
          });
      }

      return this.applyTimeEvaluation(state, nowMs);
    } finally {
      // Always remove from in-flight map; errors are never cached
      this.inFlight.delete(policyId);
    }
  }

  /**
   * Recompute full policy state from primary database and oracle feed.
   */
  public async computePolicyState(policyId: string): Promise<TimeIndependentPolicyState | null> {
    this.metrics.computations++;

    // DB query 1: fetch policy with product and claims
    this.metrics.dbQueries++;
    const policy = await this.prisma.policy.findUnique({
      where: { id: policyId },
      include: {
        product: true,
        claims: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    });

    if (!policy) {
      return null;
    }

    // DB/Oracle query 2: fetch latest oracle reading
    this.metrics.dbQueries++;
    const reading = await this.oracleService.getLatestReading(policy.oracleKey);

    const product = policy.product;
    // #712 — Parse the threshold exactly (scaled BigInt) instead of parseFloat.
    // Unlike the payout path, a non-numeric threshold here keeps the previous
    // graceful behaviour (treated as 0) rather than throwing.
    let thresholdBigInt: bigint;
    try {
      thresholdBigInt = parseDecimalScaled(product.threshold.toString());
    } catch {
      thresholdBigInt = 0n;
    }

    let triggerMet = false;
    let readingValueStr: string | null = null;
    let readingTimestamp: number | null = null;

    if (reading) {
      readingValueStr = reading.value.toString();
      // #712 — Prefer the reading's own bucket start, falling back to its
      // timestamp: OracleReading does not always carry a bucketStart.
      readingTimestamp = reading.bucketStart
        ? reading.bucketStart.getTime()
        : reading.timestamp * 1000;
      const readingVal = parseFixedPointBigInt(reading.value);
      triggerMet = compareScaledToThreshold(readingVal, thresholdBigInt, product.comparison);
    }

    const claims = policy.claims ?? [];
    const hasPaidClaim = claims.some((c) => c.status === ClaimStatus.PAID);
    const inFlightClaim = claims.find((c) => c.status === ClaimStatus.PROCESSING || c.status === ClaimStatus.PENDING);
    const hasInFlightClaim = !!inFlightClaim;

    return {
      policyId: policy.id,
      policyholder: policy.policyholder,
      productId: policy.productId,
      productName: product.name,
      coverageXlm: policy.coverageXlm.toString(),
      premiumPaid: policy.premiumPaid.toString(),
      oracleKey: policy.oracleKey,
      rawStatus: policy.status,
      startTime: policy.startTime.getTime(),
      endTime: policy.endTime.getTime(),
      threshold: product.threshold.toString(),
      comparison: product.comparison,
      latestReadingValue: readingValueStr,
      latestReadingTimestamp: readingTimestamp,
      triggerMet,
      claimsCount: claims.length,
      hasPaidClaim,
      hasInFlightClaim,
      activeClaimId: inFlightClaim?.id ?? null,
      activeClaimStatus: inFlightClaim?.status ?? null,
      cachedAt: Date.now(),
    };
  }

  /**
   * Internal memory-only invalidation (used on pub/sub events).
   */
  private invalidateMemoryOnly(policyId: string): void {
    this.memoryCache.delete(policyId);
    this.inFlight.delete(policyId);
  }

  /**
   * Invalidate cache entry for a specific policy (#714).
   * Called on every write path that mutates policy state, claims, or oracle key.
   */
  async invalidate(policyId: string): Promise<void> {
    this.metrics.invalidations++;
    this.invalidateMemoryOnly(policyId);

    if (this.redis && typeof this.redis.del === 'function') {
      try {
        await this.redis.del(this.getRedisKey(policyId));
        if (typeof this.redis.publish === 'function') {
          await this.redis.publish(INVALIDATION_CHANNEL, JSON.stringify({ policyId }));
        }
      } catch (err) {
        this.logger.warn(`Redis cache invalidate error for policy ${policyId}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Invalidate all cached entries.
   * Called on global product definition mutations.
   */
  async invalidateAll(): Promise<void> {
    this.metrics.invalidations++;
    this.memoryCache.clear();
    this.inFlight.clear();

    if (this.redis && typeof this.redis.keys === 'function') {
      try {
        const keys = await this.redis.keys('cache:policy:derived:*');
        if (keys.length > 0 && typeof this.redis.del === 'function') {
          await this.redis.del(...keys);
        }
        if (typeof this.redis.publish === 'function') {
          await this.redis.publish(INVALIDATION_CHANNEL, JSON.stringify({ all: true }));
        }
      } catch (err) {
        this.logger.warn(`Redis cache invalidateAll error: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Invalidate all policies associated with an oracle key (#714).
   */
  async invalidateByOracleKey(oracleKey: string): Promise<void> {
    try {
      const policies = await this.prisma.policy.findMany({
        where: { oracleKey },
        select: { id: true },
      });
      await Promise.all(policies.map((p) => this.invalidate(p.id)));
    } catch (err) {
      this.logger.warn(`Failed to invalidate policies for oracle key ${oracleKey}: ${(err as Error).message}`);
    }
  }
}
