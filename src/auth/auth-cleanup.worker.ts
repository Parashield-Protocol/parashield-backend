import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

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

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_6_HOURS)
  async cleanupExpiredChallenges(): Promise<void> {
    const { count } = await this.prisma.authChallenge.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });

    if (count > 0) {
      this.logger.log(`Cleaned up ${count} expired auth challenge(s)`);
    }
  }
}
