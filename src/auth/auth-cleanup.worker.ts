import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { recordWorkerHeartbeat } from '../common/worker-heartbeat';
import { DistributedLockService } from '../redis/distributed-lock.service';

/**
 * AuthCleanupWorker — periodically prunes expired AuthChallenge rows.
 *
 * Wrapped with DistributedLockService (#675) to prevent multiple instances from
 * competing on database table locks during challenge cleanup.
 */
@Injectable()
export class AuthCleanupWorker {
  private readonly logger = new Logger(AuthCleanupWorker.name);
  private readonly lockService: DistributedLockService;

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    @Optional() lockService?: DistributedLockService,
    @Optional() private readonly configService?: ConfigService,
  ) {
    this.lockService = lockService ?? new DistributedLockService(this.redis);
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async cleanupExpiredChallenges(): Promise<void> {
    const ttlMs = parseInt(
      this.configService?.get<string>('AUTH_CLEANUP_LOCK_TTL_MS') ?? '300000',
      10,
    );

    await this.lockService.runWithLock(
      'lock:job:auth-cleanup',
      ttlMs,
      async () => {
        const { count } = await this.prisma.authChallenge.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });

        if (count > 0) {
          this.logger.log(`Cleaned up ${count} expired auth challenge(s)`);
        }

        await recordWorkerHeartbeat(this.redis, 'auth-cleanup').catch((err) =>
          this.logger.warn(`Failed to record worker heartbeat: ${err instanceof Error ? err.message : String(err)}`),
        );
      },
      { enableHeartbeat: false },
    );
  }
}

