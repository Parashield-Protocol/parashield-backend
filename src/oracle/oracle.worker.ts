import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { OracleService } from './oracle.service';

/**
 * OracleWorker — scheduled job that fetches external data and submits it
 * to the Oracle Verifier contract on Stellar.
 *
 * Runs every hour. In production, frequency should match the granularity
 * of the most time-sensitive insurance product (flight = every 15 minutes).
 */
@Injectable()
export class OracleWorker {
  private readonly logger = new Logger(OracleWorker.name);

  constructor(
    private readonly oracleService: OracleService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async pollAndSubmit(): Promise<void> {
    this.logger.log('Oracle poll cycle started');

    // Kisumu, Kenya: lat=-0.0917, lng=34.7679 — primary crop insurance market
    const now   = new Date();
    const year  = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;

    try {
      const reading = await this.oracleService.fetchRainfall(-0.0917, 34.7679, year, month);
      this.logger.log(
        `Rainfall reading: key=${reading.key} value=${reading.value} confidence=${reading.confidence}`,
      );
      // TODO: submit to oracle-verifier contract via StellarService
      // await this.stellarService.submitOracleData(reading);
    } catch (err) {
      this.logger.error('Failed to fetch or submit oracle data', err);
    }

    this.logger.log('Oracle poll cycle complete');
  }
}
