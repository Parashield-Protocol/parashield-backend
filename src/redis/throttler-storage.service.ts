import { Inject, Injectable, Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { Redis } from 'ioredis';

/**
 * #XXX — Custom Throttler storage service that reuses the Redis client from RedisModule
 * instead of creating a separate connection. This eliminates duplicate Redis connections
 * which were consuming connection pool resources and requiring separate configuration.
 * 
 * Before this fix, ThrottlerModule created its own ThrottlerStorageRedisService
 * (@nest-lab/throttler-storage-redis) which created a separate Redis connection
 * in addition to the one created by RedisModule. This resulted in:
 * - Double connection count to Redis
 * - Separate retry/reconnect logic for each connection
 * - Harder to manage and monitor
 * 
 * This service integrates with the shared Redis client provided by RedisModule.
 */
@Injectable()
export class ThrottlerStorageService implements ThrottlerStorage {
  private readonly logger = new Logger(ThrottlerStorageService.name);
  private readonly memoryStore = new Map<string, { count: number; expiresAt: number }>();

  constructor(@Inject('REDIS_CLIENT') private readonly redisClient: Redis) {
    redisClient.on('error', (err: Error) => {
      this.logger.warn(
        `Throttler Redis storage is unavailable; using in-memory fallback: ${err?.message ?? String(err)}`,
      );
    });
  }

  /**
   * Increment the request count for a key with a TTL.
   * Returns the new count after incrementing.
   */
  async increment(
    key: string,
    ttl: number,
    _limit: number,
    _blockDuration: number,
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      // Use Lua script to ensure atomicity: increment and set expiry in one operation
      const script = `
        local current = redis.call('INCR', KEYS[1])
        redis.call('EXPIRE', KEYS[1], ARGV[1])
        return current
      `;

      const result = await this.redisClient.eval(script, 1, key, Math.ceil(ttl / 1000));
      const count = Number(result);
      return {
        totalHits: count,
        timeToExpire: ttl,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    } catch (err) {
      this.logger.warn(
        `Throttler Redis increment failed; using in-memory fallback: ${err instanceof Error ? err.message : String(err)}`,
      );
      const count = this.incrementInMemory(key, ttl);
      return {
        totalHits: count,
        timeToExpire: ttl,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }

  private incrementInMemory(key: string, ttl: number): number {
    const now = Date.now();
    const entry = this.memoryStore.get(key);
    if (!entry || entry.expiresAt <= now) {
      const count = 1;
      this.memoryStore.set(key, { count, expiresAt: now + ttl });
      return count;
    }

    entry.count += 1;
    return entry.count;
  }
}
