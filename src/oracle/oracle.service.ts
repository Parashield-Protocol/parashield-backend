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
}

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

  /** Persist an OracleReading to the database. */
  async persistReading(reading: OracleReading): Promise<void> {
    if (reading.confidence === 0 || reading.source === "mock") {
      this.logger.warn(
        `Skipping persistence of mock/confidence-0 reading for key: ${reading.key}`,
      );
      return;
    }
    await this.prisma.oracleReading.upsert({
      where: { key_source: { key: reading.key, source: reading.source } },
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
      },
    });
    this.logger.log(
      `OracleReading persisted: key=${reading.key} value=${reading.value}`,
    );
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

    const oracleReading: OracleReading = {
      dataType: "weather",
      key: `rainfall:${lat},${lng}:${year}-${String(month).padStart(2, "0")}`,
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

    const oracleReading: OracleReading = {
      dataType: "weather",
      key: `temperature:${lat},${lng}:${year}-${String(month).padStart(2, "0")}`,
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
      data: Array<{ departure: { delay: number } }>;
    }>(url, { 
      timeout: 10_000,
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });
    const delay = res.data.data?.[0]?.departure?.delay ?? 0;

    const oracleReading: OracleReading = {
      dataType: "flight",
      key: `flight:${flightNumber}:${date}`,
      value: BigInt(Math.round(delay * 1e7)).toString(),
      confidence: 95,
      timestamp: Math.floor(Date.now() / 1000),
      source: "aviationstack",
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
