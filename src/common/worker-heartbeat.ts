import type Redis from 'ioredis';

/**
 * This repo's background jobs (ClaimsWorker, OracleWorker, AuthCleanupWorker)
 * are @Cron-based, not a real message queue with consumer groups — there's no
 * Bull/BullMQ behind them. A heartbeat written to Redis at the end of every
 * successful tick, with a TTL of roughly 2x the cron interval, is how the
 * health endpoint tells a live worker from a stuck/crashed/never-started one:
 * the key naturally expires if a tick is overdue.
 */
export const WORKER_HEARTBEATS = {
  oracle: { key: 'health:worker:oracle', ttlSeconds: 2 * 60 * 60 },
  claims: { key: 'health:worker:claims', ttlSeconds: 2 * 60 * 60 },
  'auth-cleanup': { key: 'health:worker:auth-cleanup', ttlSeconds: 12 * 60 * 60 },
} as const;

export type WorkerHeartbeatName = keyof typeof WORKER_HEARTBEATS;

export async function recordWorkerHeartbeat(redis: Redis, name: WorkerHeartbeatName): Promise<void> {
  const { key, ttlSeconds } = WORKER_HEARTBEATS[name];
  await redis.set(key, new Date().toISOString(), 'EX', ttlSeconds);
}
