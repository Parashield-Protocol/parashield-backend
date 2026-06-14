import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { OracleService, OracleReading } from './oracle.service';
import { StellarService } from '../stellar/stellar.service';

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
    private readonly stellar: StellarService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async pollAndSubmit(): Promise<void> {
    this.logger.log('Oracle poll cycle started');

    // Kisumu, Kenya: lat=-0.0917, lng=34.7679 — primary crop insurance market
    const now   = new Date();
    const year  = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;

    let reading: OracleReading | null = null;

    // Attempt 1 — primary fetch
    try {
      reading = await this.oracleService.fetchRainfall(-0.0917, 34.7679, year, month);
      this.logger.log(
        `Rainfall reading: key=${reading.key} value=${reading.value} confidence=${reading.confidence}`,
      );
    } catch (err) {
      this.logger.warn('Primary fetch failed — retrying once', err);

      // Attempt 2 — single retry on failure
      try {
        reading = await this.oracleService.fetchRainfall(-0.0917, 34.7679, year, month);
        this.logger.log(`Retry succeeded: key=${reading.key} value=${reading.value}`);
      } catch (retryErr) {
        this.logger.error('Both fetch attempts failed — skipping submission', retryErr);
        return;
      }
    }

    if (reading) {
      /*
       * Submit oracle reading to the oracle-verifier contract on Stellar.
       * Uncomment once StellarService.invokeContract is wired to the deployed contract:
       *
       * const contractId = this.config.get<string>('ORACLE_VERIFIER_CONTRACT') ?? '';
       * const txHash = await this.stellar.invokeContract(
       *   contractId,
       *   'submit_data',
       *   [
       *     nativeToScVal(reading.key, { type: 'string' }),
       *     nativeToScVal(reading.value, { type: 'i128' }),
       *     nativeToScVal(reading.confidence, { type: 'u32' }),
       *   ],
       * );
       * this.logger.log(`Oracle data submitted on-chain: txHash=${txHash}`);
       */
      this.logger.log(`[stub] Would call stellar.invokeContract('oracle-verifier', 'submit_data', reading.key=${reading.key})`);
    }

    this.logger.log('Oracle poll cycle complete');
  }
}
