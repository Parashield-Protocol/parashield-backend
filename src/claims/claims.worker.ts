import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClaimsService } from './claims.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ClaimsWorker — periodically scans for expiring policies and triggers auto-processing.
 *
 * Looks ahead 1 hour for policies whose endTime is approaching.
 * This gives the Soroban transaction time to confirm before the policy window closes.
 */
@Injectable()
export class ClaimsWorker {
  private readonly logger = new Logger(ClaimsWorker.name);

  constructor(
    private readonly claims: ClaimsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async processActivePolicies(): Promise<void> {
    this.logger.log('Claims worker tick — scanning for expiring policies');

    const now        = new Date();
    const oneHourOut = new Date(now.getTime() + 60 * 60 * 1000);

    // Find ACTIVE policies expiring within the next hour
    const expiringPolicies = await this.prisma.policy.findMany({
      where: {
        status:  'ACTIVE',
        endTime: { lte: oneHourOut },
      },
      select: { id: true, policyholder: true, endTime: true },
    });

    if (expiringPolicies.length === 0) {
      this.logger.log('No expiring policies found');
      return;
    }

    this.logger.log(`Found ${expiringPolicies.length} expiring policies — triggering auto-process`);

    // Process each expiring policy
    const results = await Promise.allSettled(
      expiringPolicies.map(async (policy) => {
        this.logger.log(
          `auto_process: policyId=${policy.id} holder=${policy.policyholder} endTime=${policy.endTime.toISOString()}`,
        );
        const result = await this.claims.autoProcess(policy.id);

        if (result !== 'Paid') {
          await this.prisma.policy.update({
            where: { id: policy.id },
            data:  { status: 'EXPIRED' },
          });
        }

        return { policyId: policy.id, result };
      }),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed    = results.filter((r) => r.status === 'rejected').length;

    this.logger.log(
      `Claims worker tick complete — succeeded: ${succeeded}, failed: ${failed}`,
    );
  }
}
