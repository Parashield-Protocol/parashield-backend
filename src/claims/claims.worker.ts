import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClaimsService } from './claims.service';
import { PrismaService } from '../prisma/prisma.service';
import { transition } from '../policy/policy-status.machine';

const BATCH_SIZE = 10;

// Returns a promise that resolves after `ms` milliseconds.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Jitter delay between batches: uniform random in [minMs, maxMs].
const jitterMs = (minMs: number, maxMs: number) =>
  minMs + Math.floor(Math.random() * (maxMs - minMs + 1));

/**
 * ClaimsWorker — periodically scans for expiring policies and triggers auto-processing.
 *
 * Looks ahead 1 hour for policies whose endTime is approaching.
 * This gives the Soroban transaction time to confirm before the policy window closes.
 *
 * Policies are processed in batches of BATCH_SIZE with a random 1–5 s jitter between
 * batches to avoid saturating the Soroban RPC node when many policies expire at once.
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
    const tickStart = Date.now();
    this.logger.log('Claims worker tick — scanning for expiring policies');

    const now        = new Date();
    const oneHourOut = new Date(now.getTime() + 60 * 60 * 1000);

    const expiringPolicies = await this.prisma.policy.findMany({
      where: {
        status:  'ACTIVE',
        endTime: { lte: oneHourOut },
      },
      select: { id: true, policyholder: true, endTime: true, status: true },
    });

    if (expiringPolicies.length === 0) {
      this.logger.log('No expiring policies found');
      return;
    }

    this.logger.log(
      `Found ${expiringPolicies.length} expiring policies — processing in batches of ${BATCH_SIZE}`,
    );

    let totalSucceeded = 0;
    let totalFailed    = 0;
    let totalRpcErrors = 0;

    for (let i = 0; i < expiringPolicies.length; i += BATCH_SIZE) {
      const batch      = expiringPolicies.slice(i, i + BATCH_SIZE);
      const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(expiringPolicies.length / BATCH_SIZE);

      this.logger.log(`Processing batch ${batchIndex}/${totalBatches} (${batch.length} policies)`);

      const batchResults = await Promise.allSettled(
        batch.map(async (policy) => {
          this.logger.log(
            `auto_process: policyId=${policy.id} holder=${policy.policyholder} endTime=${policy.endTime.toISOString()}`,
          );

          let result: string;
          try {
            result = await this.claims.autoProcess(policy.id);
          } catch (err) {
            const isRpcError =
              err instanceof Error &&
              (err.message.includes('RPC') ||
                err.message.includes('soroban') ||
                err.message.includes('network') ||
                err.message.includes('timeout'));
            if (isRpcError) totalRpcErrors++;
            throw err;
          }

          if (result !== 'Paid') {
            await this.prisma.policy.update({
              where: { id: policy.id },
              data:  { status: transition(policy.status, 'EXPIRED') as any },
            });
          }

          return { policyId: policy.id, result };
        }),
      );

      const batchSucceeded = batchResults.filter((r) => r.status === 'fulfilled').length;
      const batchFailed    = batchResults.filter((r) => r.status === 'rejected').length;
      totalSucceeded += batchSucceeded;
      totalFailed    += batchFailed;

      this.logger.log(
        `Batch ${batchIndex}/${totalBatches} complete — succeeded: ${batchSucceeded}, failed: ${batchFailed}`,
      );

      // Jitter between batches so we don't hammer the RPC node on the next one.
      if (i + BATCH_SIZE < expiringPolicies.length) {
        const delay = jitterMs(1_000, 5_000);
        this.logger.debug(`Jitter delay before next batch: ${delay}ms`);
        await sleep(delay);
      }
    }

    const elapsedMs = Date.now() - tickStart;
    this.logger.log(
      `Claims worker tick complete — policies: ${expiringPolicies.length}, ` +
      `succeeded: ${totalSucceeded}, failed: ${totalFailed}, ` +
      `rpcErrors: ${totalRpcErrors}, elapsedMs: ${elapsedMs}`,
    );
  }
}
