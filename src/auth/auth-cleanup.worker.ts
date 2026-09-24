import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { recordWorkerHeartbeat } from '../common/worker-heartbeat';

/**
 * AuthCleanupWorker — periodically prunes expired AuthChallenge rows.
 *
 * #489 — this is the only place expired challenges are pruned. The cleanup
 * used to also run on every GET /auth/challenge, which put a table-wide
 * deleteMany on the hot path of every login. Stale rows are harmless in the
 * meantime: login rejects an expired nonce and the next challenge for the
 * same wallet overwrites its row via upsert. This runs independently of
 * request traffic, mirroring the pattern used by ClaimsWorker.
 */
@Injectable()
export class AuthCleanupWorker {
  private readonly logger = new Logger(AuthCleanupWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
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
