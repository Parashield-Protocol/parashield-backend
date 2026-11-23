import { Inject, Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
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
  constructor(@Inject('REDIS_CLIENT') private readonly redisClient: Redis) {}

  /**
   * Increment the request count for a key with a TTL.
   * Returns the new count after incrementing.
   */
  async increment(key: string, ttl: number): Promise<number> {
    // Use Lua script to ensure atomicity: increment and set expiry in one operation
    const script = `
      local current = redis.call('INCR', KEYS[1])
      redis.call('EXPIRE', KEYS[1], ARGV[1])
      return current
    `;
    
    const result = await this.redisClient.eval(script, 1, key, Math.ceil(ttl / 1000));
    return Number(result);
  }
}
