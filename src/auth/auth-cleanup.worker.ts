import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { recordWorkerHeartbeat } from '../common/worker-heartbeat';

/**
 * AuthCleanupWorker — periodically prunes expired AuthChallenge rows.
 *
 * Expired challenges are also opportunistically cleaned up whenever a new
 * challenge is requested for the same wallet (see AuthController#getChallenge),
 * but that only touches rows for wallets that come back. A wallet that
 * requests a challenge once and never returns — or fails login — leaves a
 * permanent row with no other trigger to remove it. This runs independently
 * of request traffic, mirroring the pattern used by ClaimsWorker.
 */
@Injectable()
export class AuthCleanupWorker {
  private readonly logger = new Logger(AuthCleanupWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  @Cron(CronExpression.EVERY_6_HOURS)
  async cleanupExpiredChallenges(): Promise<void> {
    const { count } = await this.prisma.authChallenge.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });

    if (count > 0) {
      this.logger.log(`Cleaned up ${count} expired auth challenge(s)`);
    }

    await recordWorkerHeartbeat(this.redis, 'auth-cleanup').catch((err) =>
      this.logger.warn(`Failed to record worker heartbeat: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}
