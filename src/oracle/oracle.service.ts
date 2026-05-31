import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

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

  constructor(private readonly config: ConfigService) {}

  /** Fetch rainfall in mm for a lat/lng coordinate. Returns 7-decimal fixed point. */
  async fetchRainfall(lat: number, lng: number, year: number, month: number): Promise<OracleReading> {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate   = new Date(year, month, 0);
    const endStr    = `${year}-${String(month).padStart(2, '0')}-${endDate.getDate()}`;

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=precipitation_sum&start_date=${startDate}&end_date=${endStr}&timezone=UTC`;
    const res = await axios.get<{ daily: { precipitation_sum: number[] } }>(url, { timeout: 10_000 });

    const readings = res.data.daily.precipitation_sum.filter((v) => v !== null && v !== undefined);
    const totalMm  = readings.reduce((a, b) => a + b, 0);

    return {
      dataType:   'weather',
      key:        `rainfall:${lat},${lng}:${year}-${String(month).padStart(2, '0')}`,
      value:      BigInt(Math.round(totalMm * 1e7)),
      confidence: 90,
      timestamp:  Math.floor(Date.now() / 1000),
      source:     'open-meteo',
    };
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
    return {
      dataType:   'flight',
      key:        `flight:${flightNumber}:${date}`,
      value:      BigInt(Math.round(delay * 1e7)),
      confidence: 95,
      timestamp:  Math.floor(Date.now() / 1000),
      source:     'aviationstack',
    };
  }
}
