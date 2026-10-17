import { Injectable, Inject, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import * as crypto from 'crypto';

export interface LockOptions {
  ttlMs?: number;
  extendIntervalMs?: number;
  enableHeartbeat?: boolean;
}

/**
 * DistributedLockService — provides distributed locking using Redis primitives (#675).
 *
 * Implements safe distributed locking across multiple instances:
 * - Acquire: SET key token NX PX ttl, where token is a random per-acquisition string.
 * - Release: Atomic compare-and-delete Lua script (never blind DEL) so a stale
 *   holder can never release another instance's lock.
 * - Renewal: Heartbeat/watchdog extends the lock periodically while a long-running
 *   job is executing.
 * - Fail-safe: If Redis is unreachable, skips execution and logs error loudly
 *   to avoid data corruption / duplicate transactions.
 */
@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger(DistributedLockService.name);

  // Atomic compare-and-delete Lua script:
  // Deletes the key ONLY if the currently stored value matches the token.
  private static readonly COMPARE_AND_DELETE_LUA = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;

  // Atomic lock renewal Lua script:
  // Extends the PEXPIRE ttl ONLY if the currently stored value matches the token.
  private static readonly RENEW_LOCK_LUA = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("PEXPIRE", KEYS[1], ARGV[2])
    else
      return 0
    end
  `;

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  /**
   * Acquire a distributed lock.
   *
   * @param key Lock identifier (e.g. 'lock:job:oracle-worker')
   * @param ttlMs Lock time-to-live in milliseconds
   * @returns Generated acquisition token if acquired, or null if lock is held or Redis is down.
   */
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString('hex');

    try {
      // SET key token PX ttlMs NX: sets key only if it does not already exist
      const result = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
      return result === 'OK' ? token : null;
    } catch (err) {
      // Fail-safe decision: For financial and blockchain background jobs
      // (oracle submissions, claims processing, payouts), running concurrently
      // can cause irreversible state corruption and duplicate transactions.
      // If Redis is unreachable, we skip the run and log loudly.
      this.logger.error(
        `[DistributedLock] Redis unreachable during lock acquisition for "${key}": ` +
        `${err instanceof Error ? err.message : String(err)}. Skipping execution to prevent data corruption.`,
      );
      return null;
    }
  }

  /**
   * Release the distributed lock.
   *
   * Uses an atomic Lua script that compares the stored token with our token
   * before deleting. Returns true if released, false if the token did not match
   * (e.g. lock expired and was acquired by another instance).
   */
  async release(key: string, token: string): Promise<boolean> {
    try {
      const result = await this.redis.eval(
        DistributedLockService.COMPARE_AND_DELETE_LUA,
        1,
        key,
        token,
      );
      return Number(result) === 1;
    } catch (err) {
      this.logger.warn(
        `[DistributedLock] Error releasing lock "${key}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Extend lock expiration while a job is running.
   */
  async renew(key: string, token: string, ttlMs: number): Promise<boolean> {
    try {
      const result = await this.redis.eval(
        DistributedLockService.RENEW_LOCK_LUA,
        1,
        key,
        token,
        ttlMs,
      );
      return Number(result) === 1;
    } catch (err) {
      this.logger.warn(
        `[DistributedLock] Error renewing lock "${key}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Run a task exclusively under a distributed lock.
   *
   * - If lock not acquired: logs that the run was skipped because lock is held (no spinning/queueing).
   * - If lock acquired: runs task, maintains heartbeat renewal if enabled, releases in finally block.
   */
  async runWithLock<T>(
    key: string,
    ttlMs: number,
    task: () => Promise<T>,
    options?: LockOptions,
  ): Promise<{ executed: boolean; result?: T }> {
    const token = await this.acquire(key, ttlMs);
    if (!token) {
      this.logger.log(`Skipping scheduled run: lock "${key}" is currently held by another instance`);
      return { executed: false };
    }

    let heartbeatTimer: NodeJS.Timeout | undefined;
    const enableHeartbeat = options?.enableHeartbeat ?? true;
    const extendIntervalMs = options?.extendIntervalMs ?? Math.floor(ttlMs / 3);

    if (enableHeartbeat && extendIntervalMs > 0) {
      heartbeatTimer = setInterval(async () => {
        const renewed = await this.renew(key, token, ttlMs);
        if (!renewed) {
          this.logger.warn(
            `[DistributedLock] Watchdog heartbeat failed to renew lock "${key}". Holder token may have expired.`,
          );
        }
      }, extendIntervalMs);

      if (typeof heartbeatTimer.unref === 'function') {
        heartbeatTimer.unref();
      }
    }

    try {
      const result = await task();
      return { executed: true, result };
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      await this.release(key, token);
    }
  }
}
