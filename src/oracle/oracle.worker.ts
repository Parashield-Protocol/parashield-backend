import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { OracleService, OracleReading } from './oracle.service';
import { StellarService } from '../stellar/stellar.service';
import { PrismaService } from '../prisma/prisma.service';

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
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async pollAndSubmit(): Promise<void> {
    this.logger.log('Oracle poll cycle started');

    const now   = new Date();
    const year  = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const formattedMonth = String(month).padStart(2, '0');

    // Query active policies from the database
    let activePolicies: Array<{ oracleKey: string }> = [];
    try {
      activePolicies = await this.prisma.policy.findMany({
        where: { status: 'ACTIVE' },
        select: { oracleKey: true },
      });
    } catch (err) {
      this.logger.error('Failed to fetch active policies from database', err);
    }

    let uniqueKeys = [...new Set(activePolicies.map((p) => p.oracleKey))];
    if (uniqueKeys.length === 0) {
      this.logger.log('No active policies found. Using Kisumu rainfall coordinates as fallback.');
      uniqueKeys = [`rainfall:-0.0917,34.7679:${year}-${formattedMonth}`];
    }

    for (const key of uniqueKeys) {
      this.logger.log(`Processing oracle key: ${key}`);
      try {
        let reading: OracleReading | null = null;

        if (key.startsWith('rainfall:')) {
          const match = key.match(/^rainfall:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?):(\d{4})-(\d{2})$/);
          if (!match) {
            this.logger.warn(`Invalid rainfall key format: ${key} — skipping`);
            continue;
          }
          const lat = parseFloat(match[1]);
          const lng = parseFloat(match[2]);
          const keyYear = parseInt(match[3], 10);
          const keyMonth = parseInt(match[4], 10);

          reading = await this.fetchWithRetry(() =>
            this.oracleService.fetchRainfallReading(lat, lng, keyYear, keyMonth),
          );
        } else if (key.startsWith('flight:')) {
          const match = key.match(/^flight:([A-Z0-9]+):(\d{4}-\d{2}-\d{2})$/);
          if (!match) {
            this.logger.warn(`Invalid flight key format: ${key} — skipping`);
            continue;
          }
          const flightNumber = match[1];
          const date = match[2];

          reading = await this.fetchWithRetry(() =>
            this.oracleService.fetchFlightDelayReading(flightNumber, date),
          );
        } else if (key.startsWith('defi:')) {
          this.logger.warn(`DeFi oracle keys are not yet supported: key=${key} — skipping`);
          continue;
        } else {
          this.logger.warn(`Unknown oracle key type: key=${key} — skipping`);
          continue;
        }

        if (reading) {
          try {
            await this.oracleService.persistReading(reading);
          } catch (err) {
            this.logger.error(`Oracle reading persistence failed for key=${key} — skipping on-chain submission`, err);
            continue;
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
              this.logger.log(`Oracle data submitted on-chain for key=${reading.key}: txHash=${txHash}`);
            } catch (err) {
              this.logger.error(`On-chain oracle submission failed for key=${reading.key}`, err);
            }
          }
        }
      } catch (err) {
        this.logger.error(`Failed to process oracle key ${key}`, err);
      }
    }

    this.logger.log('Oracle poll cycle complete');
  }

  private async fetchWithRetry<T>(fetchFn: () => Promise<T>): Promise<T | null> {
    try {
      const reading = await fetchFn();
      const res = reading as any;
      if (res && 'key' in res) {
        this.logger.log(
          `Primary fetch succeeded: key=${res.key} value=${res.value} confidence=${res.confidence}`,
        );
      }
      return reading;
    } catch (err) {
      this.logger.warn(`Primary fetch failed — retrying once in ${this.retryDelayMs / 1000}s`, err);
      await this.sleep(this.retryDelayMs);

      try {
        const reading = await fetchFn();
        const res = reading as any;
        if (res && 'key' in res) {
          this.logger.log(`Retry succeeded: key=${res.key} value=${res.value}`);
        }
        return reading;
      } catch (retryErr) {
        this.logger.error('Both fetch attempts failed', retryErr);
        return null;
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
