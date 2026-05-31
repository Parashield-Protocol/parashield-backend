import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClaimsService } from './claims.service';

/**
 * ClaimsWorker — periodically calls auto_process on all active policies.
 *
 * In production, this queries a DB index of active policy IDs and
 * submits auto_process for each. In v1 the policy list is fetched from
 * the PolicyService on every tick.
 */
@Injectable()
export class ClaimsWorker {
  private readonly logger = new Logger(ClaimsWorker.name);

  constructor(private readonly claims: ClaimsService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async processActivePolicies(): Promise<void> {
    this.logger.log('Claims worker tick — processing active policies');
    // TODO: fetch active policy IDs from PolicyService and call auto_process for each
    this.logger.log('Claims worker tick complete');
  }
}
