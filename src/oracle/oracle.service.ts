import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { PrismaService } from "../prisma/prisma.service";

export interface OracleReading {
  dataType: string;
  key: string;
  value: string; // 7-decimal fixed point, serialized as string to survive JSON.stringify
  confidence: number;
  timestamp: number;
  source: string;
  /** OK when the upstream returned real data, NO_DATA when the value is unknown (#171). */
  status?: "OK" | "NO_DATA";
}

/** Length of an oracle idempotency bucket in ms — matches the hourly cron cadence (#172). */
export const ORACLE_BUCKET_MS = 3_600_000;

/**
 * Plausibility bounds applied to upstream values before they can reach the
 * chain (#173). Anything outside these ranges is treated as a fetch failure.
 */
export const SANITY_BOUNDS = {
  /** Monthly rainfall in mm — negative is impossible, 20m/month is far beyond any record. */
  rainfall: { min: 0, max: 20_000 },
  /** Daily max temperature in °C. */
  temperature: { min: -100, max: 100 },
  /** Flight departure delay in minutes — capped at 14 days. */
  delay: { min: 0, max: 20_160 },
} as const;

/**
 * OracleService — fetches real-world data and formats it for on-chain submission.
 *
 * Data sources:
 *  - Weather (rainfall, temperature, wind): Open-Meteo API (free, no key)
 *  - Flight status: AviationStack API (key required)
 *  - DeFi events: On-chain monitoring via Stellar RPC
 *
 * All values are expressed in 7-decimal fixed point to match Stellar asset precision.
 * Example: 32.4mm rainfall → 324_000_000 (multiply by 10^7)
 */
@Injectable()
export class OracleService {
  private readonly logger = new Logger(OracleService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Truncate a Unix-second timestamp to the start of its idempotency bucket (#172).
   * All replicas processing the same cron cycle derive the same bucket, so their
   * upserts collapse onto a single row.
   */
  bucketStartFor(
    timestampSeconds: number,
    bucketMs: number = ORACLE_BUCKET_MS,
  ): Date {
    const ms = timestampSeconds * 1000;
    return new Date(Math.floor(ms / bucketMs) * bucketMs);
  }

  /**
   * Reject implausible upstream values before they can be submitted on-chain (#173).
   * Out-of-range data is treated as a fetch failure so the worker's retry/skip
   * path handles it instead of the contract.
   */
  private assertWithinBounds(
    label: keyof typeof SANITY_BOUNDS,
    value: number,
    key: string,
  ): void {
    const { min, max } = SANITY_BOUNDS[label];
    if (!Number.isFinite(value) || value < min || value > max) {
      this.logger.error(
        `Rejecting out-of-range ${label} value for key=${key}: ${value} (allowed ${min}..${max})`,
      );
      throw new ServiceUnavailableException(
        `Upstream ${label} value ${value} is outside the plausible range ${min}..${max}`,
      );
    }
  }

  /** Persist an OracleReading to the database. */
  async persistReading(reading: OracleReading): Promise<void> {
    if (
      reading.confidence === 0 ||
      reading.status === "NO_DATA" ||
      reading.source === "mock"
    ) {
      this.logger.warn(
        `Skipping persistence of mock/confidence-0 reading for key: ${reading.key}`,
      );
      return;
    }
    await this.prisma.oracleReading.upsert({
      where: {
        key_source_bucket: {
          key: reading.key,
          source: reading.source,
          bucketStart: this.bucketStartFor(reading.timestamp),
        },
      },
      update: {
        dataType: reading.dataType,
        value: BigInt(reading.value),
        confidence: reading.confidence,
        submittedAt: new Date(),
      },
      create: {
        dataType: reading.dataType,
        key: reading.key,
        value: BigInt(reading.value),
        confidence: reading.confidence,
        source: reading.source,
        bucketStart: this.bucketStartFor(reading.timestamp),
      },
    });
    this.logger.log(
      `OracleReading persisted: key=${reading.key} value=${reading.value}`,
    );
  }

  /**
   * Atomically claim the right to submit a reading on-chain for its bucket (#172).
   *
   * The conditional update is the distributed lock: only the replica whose
   * UPDATE matches the still-unsubmitted row gets a count of 1, every other
   * replica gets 0 and skips the contract call.
   */
  async claimForOnChainSubmission(reading: OracleReading): Promise<boolean> {
    const { count } = await this.prisma.oracleReading.updateMany({
      where: {
        key: reading.key,
        source: reading.source,
        bucketStart: this.bucketStartFor(reading.timestamp),
        onChainSubmitted: false,
      },
      data: { onChainSubmitted: true },
    });

    if (count === 0) {
      this.logger.warn(
        `Duplicate oracle submission suppressed for key=${reading.key} bucket=${this.bucketStartFor(reading.timestamp).toISOString()}`,
      );
      return false;
    }
    return true;
  }

  /** Record the transaction hash of a successful on-chain submission (#172). */
  async recordOnChainSubmission(
    reading: OracleReading,
    txHash: string,
  ): Promise<void> {
    await this.prisma.oracleReading.updateMany({
      where: {
        key: reading.key,
        source: reading.source,
        bucketStart: this.bucketStartFor(reading.timestamp),
      },
      data: { onChainTxHash: txHash },
    });
  }

  /**
   * Release a claim whose on-chain submission failed so the next cron cycle can
   * retry the same bucket (#172).
   */
  async releaseOnChainClaim(reading: OracleReading): Promise<void> {
    await this.prisma.oracleReading.updateMany({
      where: {
        key: reading.key,
        source: reading.source,
        bucketStart: this.bucketStartFor(reading.timestamp),
        onChainTxHash: null,
      },
      data: { onChainSubmitted: false },
    });
  }

  /** Get all stored oracle readings ordered by submittedAt desc, with an optional row cap. */
  async getAllReadings(limit = 100): Promise<OracleReading[]> {
    const records = await this.prisma.oracleReading.findMany({
      orderBy: { submittedAt: "desc" },
      take: Math.min(limit, 500),
    });

    return records.map((record) => ({
      dataType: record.dataType,
      key: record.key,
      value: record.value.toString(),
      confidence: record.confidence,
      timestamp: Math.floor(record.submittedAt.getTime() / 1000),
      source: record.source,
    }));
  }

  /** Get the latest reading for a given oracle key from the database. */
  async getLatestReading(key: string): Promise<OracleReading | null> {
    const record = await this.prisma.oracleReading.findFirst({
      where: { key },
      orderBy: { submittedAt: "desc" },
    });

    if (!record) return null;

    return {
      dataType: record.dataType,
      key: record.key,
      value: record.value.toString(),
      confidence: record.confidence,
      timestamp: Math.floor(record.submittedAt.getTime() / 1000),
      source: record.source,
    };
  }

  /** Fetch rainfall in mm for a lat/lng coordinate without persisting it. */
  async fetchRainfallReading(
    lat: number,
    lng: number,
    year: number,
    month: number,
  ): Promise<OracleReading> {
    const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
    const endDate = new Date(year, month, 0);
    const endStr = `${year}-${String(month).padStart(2, "0")}-${endDate.getDate()}`;

    // Determine if the requested month is in the past relative to today.
    const today = new Date();
    const isPastMonth =
      year < today.getFullYear() ||
      (year === today.getFullYear() && month < today.getMonth() + 1);

    // Choose appropriate Open-Meteo endpoint.
    // - For past months, use /archive (historical observed data only)
    // - For current/future months, use /forecast (may include forecasted data)
    const url = isPastMonth
      ? `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&daily=precipitation_sum&start_date=${startDate}&end_date=${endStr}&timezone=UTC`
      : `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=precipitation_sum&start_date=${startDate}&end_date=${endStr}&timezone=UTC`;

    const res = await axios.get<{
      daily: { precipitation_sum: (number | null)[]; time: string[] };
    }>(url, { timeout: 10_000 });

    // Filter to only observed days (date <= today) and exclude null values.
    // For past months from /archive endpoint, all data is observed.
    // For current/forecast months from /forecast endpoint, exclude future forecasts.
    const todayStr = today.toISOString().split("T")[0]; // YYYY-MM-DD format
    const precipitation = res.data.daily.precipitation_sum;
    const times = res.data.daily.time;

    const observedReadings = precipitation.reduce(
      (arr: number[], value, idx) => {
        // Skip null or undefined values (missing data)
        if (value === null || value === undefined) return arr;

        // Check if this day is observed (on or before today)
        const date = times?.[idx];
        if (date && date > todayStr) {
          // Skip future forecasted days
          return arr;
        }

        // Include observed/historical day
        arr.push(value);
        return arr;
      },
      [],
    );

    // Sum only observed rainfall
    const totalMm = observedReadings.reduce((a, b) => a + b, 0);

    // Calculate confidence based on observed days coverage within the month.
    // For past months (all observed), this reflects data completeness.
    // For current month, this reflects how many observed days we have.
    const daysInMonth = endDate.getDate();
    const observedCount = observedReadings.length;
    const coverage = observedCount / daysInMonth;
    const confidence = Math.round(coverage * 95);

    const key = `rainfall:${lat},${lng}:${year}-${String(month).padStart(2, "0")}`;
    for (const daily of observedReadings) {
      this.assertWithinBounds("rainfall", daily, key);
    }
    this.assertWithinBounds("rainfall", totalMm, key);

    const oracleReading: OracleReading = {
      dataType: "weather",
      key,
      value: BigInt(Math.round(totalMm * 1e7)).toString(),
      confidence,
      timestamp: Math.floor(Date.now() / 1000),
      source: "open-meteo",
    };

    return oracleReading;
  }

  /** Fetch rainfall in mm for a lat/lng coordinate. Returns 7-decimal fixed point. */
  async fetchRainfall(
    lat: number,
    lng: number,
    year: number,
    month: number,
  ): Promise<OracleReading> {
    const oracleReading = await this.fetchRainfallReading(
      lat,
      lng,
      year,
      month,
    );
    await this.persistReading(oracleReading);
    return oracleReading;
  }

  /** Fetch monthly average max temperature for a lat/lng coordinate without persisting it. */
  async fetchTemperatureReading(
    lat: number,
    lng: number,
    year: number,
    month: number,
  ): Promise<OracleReading> {
    const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
    const endDate = new Date(year, month, 0);
    const endStr = `${year}-${String(month).padStart(2, "0")}-${endDate.getDate()}`;

    const today = new Date();
    const isPastMonth =
      year < today.getFullYear() ||
      (year === today.getFullYear() && month < today.getMonth() + 1);

    const url = isPastMonth
      ? `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&daily=temperature_2m_max&start_date=${startDate}&end_date=${endStr}&timezone=UTC`
      : `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=temperature_2m_max&start_date=${startDate}&end_date=${endStr}&timezone=UTC`;
    const res = await axios.get<{
      daily: { temperature_2m_max: (number | null)[]; time: string[] };
    }>(url, { timeout: 10_000 });

    const todayStr = today.toISOString().split("T")[0];
    const rawTemps = res.data.daily.temperature_2m_max;
    const times = res.data.daily.time;

    const temps = rawTemps.filter((v, idx): v is number => {
      if (v === null || v === undefined) return false;
      const date = times?.[idx];
      if (date && date > todayStr) return false;
      return true;
    });

    const avgTemp =
      temps.length > 0 ? temps.reduce((a, b) => a + b, 0) / temps.length : 0;

    const expectedDays = endDate.getDate();
    const coverage = temps.length / expectedDays;
    const confidence = Math.round(coverage * 95);

    const key = `temperature:${lat},${lng}:${year}-${String(month).padStart(2, "0")}`;
    // Only validate observed data — an empty window legitimately yields 0 with
    // confidence 0 and is filtered by the worker's confidence gate.
    if (temps.length > 0) {
      for (const daily of temps) {
        this.assertWithinBounds("temperature", daily, key);
      }
      this.assertWithinBounds("temperature", avgTemp, key);
    }

    const oracleReading: OracleReading = {
      dataType: "weather",
      key,
      value: BigInt(Math.round(avgTemp * 1e7)).toString(),
      confidence,
      timestamp: Math.floor(Date.now() / 1000),
      source: "open-meteo",
    };

    return oracleReading;
  }

  /** Fetch monthly average max temperature for a lat/lng coordinate. Returns 7-decimal fixed point (°C * 10^7). */
  async fetchTemperature(
    lat: number,
    lng: number,
    year: number,
    month: number,
  ): Promise<OracleReading> {
    const oracleReading = await this.fetchTemperatureReading(
      lat,
      lng,
      year,
      month,
    );
    await this.persistReading(oracleReading);
    return oracleReading;
  }

  /** Fetch flight delay status without persisting it. */
  async fetchFlightDelayReading(
    flightNumber: string,
    date: string,
  ): Promise<OracleReading> {
    const apiKey = this.config.get<string>("AVIATIONSTACK_API_KEY");
    if (!apiKey) {
      this.logger.warn(
        "AVIATIONSTACK_API_KEY not set — flight delay oracle query failed",
      );
      throw new ServiceUnavailableException(
        "AviationStack API is not configured.",
      );
    }
    const url = `https://api.aviationstack.com/v1/flights?flight_iata=${flightNumber}&flight_date=${date}`;
    const res = await axios.get<{
      data?: Array<{ departure?: { delay?: number | null } | null } | null>;
    }>(url, {
      timeout: 10_000,
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });
    const key = `flight:${flightNumber}:${date}`;
    const flight = res.data.data?.[0];
    const delay = flight?.departure?.delay;

    // A missing flight or a null delay means "unknown", not "on time" (#171).
    // Emitting confidence 0 + NO_DATA keeps it out of the DB and off-chain
    // instead of masquerading as a genuine 0-minute delay.
    if (!flight || delay === null || delay === undefined) {
      this.logger.warn(
        `AviationStack returned no usable delay for ${key} — emitting NO_DATA with confidence 0`,
      );
      return {
        dataType: "flight",
        key,
        value: "0",
        confidence: 0,
        timestamp: Math.floor(Date.now() / 1000),
        source: "aviationstack",
        status: "NO_DATA",
      };
    }

    this.assertWithinBounds("delay", delay, key);

    const oracleReading: OracleReading = {
      dataType: "flight",
      key,
      value: BigInt(Math.round(delay * 1e7)).toString(),
      confidence: 95,
      timestamp: Math.floor(Date.now() / 1000),
      source: "aviationstack",
      status: "OK",
    };

    return oracleReading;
  }

  /** Fetch flight delay status. Returns delay in minutes as 7-decimal fixed point. */
  async fetchFlightDelay(
    flightNumber: string,
    date: string,
  ): Promise<OracleReading> {
    const oracleReading = await this.fetchFlightDelayReading(
      flightNumber,
      date,
    );
    await this.persistReading(oracleReading);
    return oracleReading;
  }
}
