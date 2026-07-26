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
  private readonly defaultMinConfidence = 1;

  // Cumulative cycle metrics — submitted vs skipped vs duplicate vs failed fetches.
  private submittedCount = 0;
  private skippedCount = 0;
  private duplicateCount = 0;
  private invalidCount = 0;

  /** Snapshot of the worker's lifetime submission metrics. */
  getMetrics(): { submitted: number; skipped: number; duplicates: number; invalid: number } {
    return {
      submitted: this.submittedCount,
      skipped: this.skippedCount,
      duplicates: this.duplicateCount,
      invalid: this.invalidCount,
    };
  }

  /**
   * Minimum confidence a reading must carry to be submitted on-chain.
   * Defaults to 1 so only unknown/no-data readings (confidence 0) are dropped (#171).
   */
  private getMinConfidence(): number {
    const raw = this.config.get<string>('ORACLE_MIN_CONFIDENCE');
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : this.defaultMinConfidence;
  }

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
          // Unknown or low-confidence data must never reach the chain (#171).
          const minConfidence = this.getMinConfidence();
          if (reading.status === 'NO_DATA' || reading.confidence < minConfidence) {
            this.skippedCount += 1;
            this.logger.warn(
              `Skipping oracle key=${key}: status=${reading.status ?? 'OK'} confidence=${reading.confidence} < ${minConfidence}`,
            );
            continue;
          }

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
            // Atomically claim this (key, source, bucket) so a second cron run or
            // a parallel replica cannot submit the same reading twice (#172).
            let claimed = false;
            try {
              claimed = await this.oracleService.claimForOnChainSubmission(reading);
            } catch (err) {
              this.logger.error(`Failed to claim oracle submission slot for key=${reading.key} — skipping on-chain submission`, err);
              continue;
            }

            if (!claimed) {
              this.duplicateCount += 1;
              this.logger.warn(`Oracle reading for key=${reading.key} already submitted for this bucket — skipping`);
              continue;
            }

            try {
              const txHash = await this.stellar.invokeContract(
                contractId,
                'submit_data',
                [
                  nativeToScVal(reading.dataType,          { type: 'symbol' }),
                  nativeToScVal(reading.key,               { type: 'symbol' }),
                  nativeToScVal(BigInt(reading.value),     { type: 'i128' }),
                  nativeToScVal(reading.confidence,        { type: 'u32' }),
                  nativeToScVal(BigInt(reading.timestamp), { type: 'u64' }),
                ],
              );
              this.submittedCount += 1;
              await this.oracleService.recordOnChainSubmission(reading, txHash);
              this.logger.log(`Oracle data submitted on-chain for key=${reading.key}: txHash=${txHash}`);
            } catch (err) {
              this.logger.error(`On-chain oracle submission failed for key=${reading.key}`, err);
              // Release the claim so the next cycle can retry this bucket.
              await this.oracleService
                .releaseOnChainClaim(reading)
                .catch((releaseErr) =>
                  this.logger.error(`Failed to release oracle submission claim for key=${reading.key}`, releaseErr),
                );
            }
          }
        }
        if (!reading) {
          this.invalidCount += 1;
        }
      } catch (err) {
        this.invalidCount += 1;
        this.logger.error(`Failed to process oracle key ${key}`, err);
      }
    }

    const metrics = this.getMetrics();
    this.logger.log(
      `Oracle poll cycle complete — submitted=${metrics.submitted} skipped=${metrics.skipped} duplicates=${metrics.duplicates} invalid=${metrics.invalid}`,
    );
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
