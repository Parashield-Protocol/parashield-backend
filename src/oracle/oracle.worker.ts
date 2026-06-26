import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { nativeToScVal } from '@stellar/stellar-sdk';
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
  private readonly retryDelayMs = 5_000;

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
      reading = await this.oracleService.fetchRainfallReading(-0.0917, 34.7679, year, month);
      this.logger.log(
        `Rainfall reading: key=${reading.key} value=${reading.value} confidence=${reading.confidence}`,
      );
    } catch (err) {
      this.logger.warn(`Primary fetch failed — retrying once in ${this.retryDelayMs / 1000}s`, err);
      await this.sleep(this.retryDelayMs);

      // Attempt 2 — single retry on failure
      try {
        reading = await this.oracleService.fetchRainfallReading(-0.0917, 34.7679, year, month);
        this.logger.log(`Retry succeeded: key=${reading.key} value=${reading.value}`);
      } catch (retryErr) {
        this.logger.error('Both fetch attempts failed — skipping submission', retryErr);
        return;
      }
    }

    if (reading) {
      try {
        await this.oracleService.persistReading(reading);
      } catch (err) {
        this.logger.error('Oracle reading persistence failed — skipping on-chain submission', err);
        return;
      }

      const contractId = this.config.get<string>('ORACLE_VERIFIER_CONTRACT') ?? '';
      if (!contractId) {
        this.logger.warn('ORACLE_VERIFIER_CONTRACT not set — skipping on-chain submission');
      } else {
        try {
          const txHash = await this.stellar.invokeContract(
            contractId,
            'submit_data',
            [
              nativeToScVal(reading.key,        { type: 'string' }),
              nativeToScVal(reading.value,       { type: 'i128' }),
              nativeToScVal(reading.confidence,  { type: 'u32' }),
            ],
          );
          this.logger.log(`Oracle data submitted on-chain: txHash=${txHash}`);
        } catch (err) {
          this.logger.error('On-chain oracle submission failed', err);
        }
      }
    }

    this.logger.log('Oracle poll cycle complete');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
