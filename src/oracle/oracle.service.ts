import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';

export interface OracleReading {
  dataType:   string;
  key:        string;
  value:      bigint;   // 7-decimal fixed point
  confidence: number;
  timestamp:  number;
  source:     string;
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
  private async persistReading(reading: OracleReading): Promise<void> {
    await this.prisma.oracleReading.create({
      data: {
        dataType:   reading.dataType,
        key:        reading.key,
        value:      reading.value,
        confidence: reading.confidence,
        source:     reading.source,
      },
    });
    this.logger.log(`OracleReading persisted: key=${reading.key} value=${reading.value}`);
  }

  /** Get the latest reading for a given oracle key from the database. */
  async getLatestReading(key: string): Promise<OracleReading | null> {
    const record = await this.prisma.oracleReading.findFirst({
      where: { key },
      orderBy: { submittedAt: 'desc' },
    });

    if (!record) return null;

    return {
      dataType:   record.dataType,
      key:        record.key,
      value:      record.value,
      confidence: record.confidence,
      timestamp:  Math.floor(record.submittedAt.getTime() / 1000),
      source:     record.source,
    };
  }

  /** Fetch rainfall in mm for a lat/lng coordinate. Returns 7-decimal fixed point. */
  async fetchRainfall(lat: number, lng: number, year: number, month: number): Promise<OracleReading> {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate   = new Date(year, month, 0);
    const endStr    = `${year}-${String(month).padStart(2, '0')}-${endDate.getDate()}`;

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=precipitation_sum&start_date=${startDate}&end_date=${endStr}&timezone=UTC`;
    const res = await axios.get<{ daily: { precipitation_sum: (number | null)[] } }>(url, { timeout: 10_000 });

    // Explicitly filter null/undefined values — Open-Meteo returns null for days
    // with no data (e.g. future dates, gaps in historical archive).
    // Without the type predicate, TypeScript widens the array type and reduce() may receive null.
    const readings = res.data.daily.precipitation_sum.filter(
      (v): v is number => v !== null && v !== undefined,
    );
    const totalMm  = readings.reduce((a, b) => a + b, 0);

    const oracleReading: OracleReading = {
      dataType:   'weather',
      key:        `rainfall:${lat},${lng}:${year}-${String(month).padStart(2, '0')}`,
      value:      BigInt(Math.round(totalMm * 1e7)),
      confidence: 90,
      timestamp:  Math.floor(Date.now() / 1000),
      source:     'open-meteo',
    };

    await this.persistReading(oracleReading);
    return oracleReading;
  }

  /** Fetch monthly average max temperature for a lat/lng coordinate. Returns 7-decimal fixed point (°C * 10^7). */
  async fetchTemperature(lat: number, lng: number, year: number, month: number): Promise<OracleReading> {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate   = new Date(year, month, 0);
    const endStr    = `${year}-${String(month).padStart(2, '0')}-${endDate.getDate()}`;

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=temperature_2m_max&start_date=${startDate}&end_date=${endStr}&timezone=UTC`;
    const res = await axios.get<{ daily: { temperature_2m_max: (number | null)[] } }>(url, { timeout: 10_000 });

    const temps = res.data.daily.temperature_2m_max.filter(
      (v): v is number => v !== null && v !== undefined,
    );
    const avgTemp = temps.length > 0
      ? temps.reduce((a, b) => a + b, 0) / temps.length
      : 0;

    const oracleReading: OracleReading = {
      dataType:   'weather',
      key:        `temperature:${lat},${lng}:${year}-${String(month).padStart(2, '0')}`,
      value:      BigInt(Math.round(avgTemp * 1e7)),
      confidence: 90,
      timestamp:  Math.floor(Date.now() / 1000),
      source:     'open-meteo',
    };

    await this.persistReading(oracleReading);
    return oracleReading;
  }

  /** Fetch flight delay status. Returns delay in minutes as 7-decimal fixed point. */
  async fetchFlightDelay(flightNumber: string, date: string): Promise<OracleReading> {
    const apiKey = this.config.get<string>('AVIATIONSTACK_API_KEY');
    if (!apiKey) {
      this.logger.warn('AVIATIONSTACK_API_KEY not set — returning mock flight data');
      return {
        dataType:   'flight',
        key:        `flight:${flightNumber}:${date}`,
        value:      0n,
        confidence: 0,
        timestamp:  Math.floor(Date.now() / 1000),
        source:     'mock',
      };
    }
    const url = `http://api.aviationstack.com/v1/flights?access_key=${apiKey}&flight_iata=${flightNumber}&flight_date=${date}`;
    const res = await axios.get<{ data: Array<{ departure: { delay: number } }> }>(url, { timeout: 10_000 });
    const delay = res.data.data?.[0]?.departure?.delay ?? 0;

    const oracleReading: OracleReading = {
      dataType:   'flight',
      key:        `flight:${flightNumber}:${date}`,
      value:      BigInt(Math.round(delay * 1e7)),
      confidence: 95,
      timestamp:  Math.floor(Date.now() / 1000),
      source:     'aviationstack',
    };

    await this.persistReading(oracleReading);
    return oracleReading;
  }
}
