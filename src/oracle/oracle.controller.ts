import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';
import { OracleService } from './oracle.service';
import { OracleFeedRequestDto } from './dto/oracle-reading.dto';
import { OperatorAuthGuard } from '../auth/operator-auth.guard';
import { AviationStackApiKeyGuard } from './guards/aviation-stack-api-key.guard';

@ApiTags('oracle')
@Controller('oracle')
export class OracleController {
  constructor(private readonly oracle: OracleService) {}

  /** GET /api/v1/oracle/reading?key=... — get the latest reading for an oracle key (query param) */
  @Get('reading')
  @ApiOperation({ summary: 'Get the latest oracle reading for a given key (query param)' })
  @ApiQuery({ name: 'key', required: true, description: 'Oracle data key (e.g. rainfall:-0.0917,34.7679:2026-06)' })
  @ApiResponse({ status: 200, description: 'Latest oracle reading or null if not found' })
  async getReadingByKey(@Query('key') key: string) {
    const decoded = decodeURIComponent(key ?? '');
    const reading = await this.oracle.getLatestReading(decoded);
    if (!reading) {
      return { success: false, error: `No reading found for key: ${decoded}` };
    }
    return { success: true, data: { ...reading, value: reading.value.toString() } };
  }

  /** GET /api/v1/oracle/readings?limit=... — list all stored oracle readings */
  @Get('readings')
  @ApiOperation({ summary: 'List all stored oracle readings' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max rows to return (default 100, max 500)' })
  @ApiResponse({ status: 200, description: 'Array of oracle readings ordered by submittedAt desc' })
  async getAllReadings(@Query('limit') limit?: string) {
    const cap = limit ? Math.min(parseInt(limit, 10) || 100, 500) : 100;
    const readings = await this.oracle.getAllReadings(cap);
    return { success: true, data: readings.map((r) => ({ ...r, value: r.value.toString() })) };
  }

  /** GET /api/v1/oracle/latest/:key — get the latest reading for an oracle key */
  @Get('latest/:key')
  @ApiOperation({ summary: 'Get the latest oracle reading for a given key' })
  @ApiParam({ name: 'key', description: 'Oracle data key (e.g. rainfall:-0.0917,34.7679:2026-06)' })
  @ApiResponse({ status: 200, description: 'Latest oracle reading or null if not found' })
  async getLatestReading(@Param('key') key: string) {
    const reading = await this.oracle.getLatestReading(key);
    if (!reading) {
      return { success: false, error: `No reading found for key: ${key}` };
    }
    return { success: true, data: { ...reading, value: reading.value.toString() } };
  }

  /** POST /api/v1/oracle/fetch/rainfall — trigger rainfall fetch */
  @Post('fetch/rainfall')
  @UseGuards(OperatorAuthGuard)
  @ApiBearerAuth()
  @ApiSecurity('operator-api-key')
  @ApiOperation({ summary: 'Operator-only: fetch rainfall data from Open-Meteo and persist to database' })
  @ApiResponse({ status: 201, description: 'Returns the fetched oracle reading' })
  @ApiResponse({ status: 401, description: 'Operator API key or admin bearer token required' })
  async fetchRainfall(@Body() dto: OracleFeedRequestDto) {
    const reading = await this.oracle.fetchRainfall(dto.lat, dto.lng, dto.year, dto.month);
    return { success: true, data: { ...reading, value: reading.value.toString() } };
  }

  /** POST /api/v1/oracle/fetch/temperature — trigger temperature fetch */
  @Post('fetch/temperature')
  @UseGuards(OperatorAuthGuard)
  @ApiBearerAuth()
  @ApiSecurity('operator-api-key')
  @ApiOperation({ summary: 'Operator-only: fetch temperature data from Open-Meteo and persist to database' })
  @ApiResponse({ status: 201, description: 'Returns the fetched oracle reading' })
  @ApiResponse({ status: 401, description: 'Operator API key or admin bearer token required' })
  async fetchTemperature(@Body() dto: OracleFeedRequestDto) {
    const reading = await this.oracle.fetchTemperature(dto.lat, dto.lng, dto.year, dto.month);
    return { success: true, data: { ...reading, value: reading.value.toString() } };
  }

  /** GET /api/v1/oracle/rainfall — legacy: fetch rainfall via query params */
  @Get('rainfall')
  @ApiOperation({ summary: 'Fetch rainfall (legacy query-param endpoint)' })
  @ApiQuery({ name: 'lat', required: true })
  @ApiQuery({ name: 'lng', required: true })
  @ApiQuery({ name: 'year', required: true })
  @ApiQuery({ name: 'month', required: true })
  async getRainfall(
    @Query('lat')   lat:   string,
    @Query('lng')   lng:   string,
    @Query('year')  year:  string,
    @Query('month') month: string,
  ) {
    const reading = await this.oracle.fetchRainfall(
      parseFloat(lat),
      parseFloat(lng),
      parseInt(year),
      parseInt(month),
    );
    return { success: true, data: { ...reading, value: reading.value.toString() } };
  }

  /** GET /api/v1/oracle/flight — fetch flight delay status */
  @Get('flight')
  @UseGuards(AviationStackApiKeyGuard)
  @ApiOperation({ summary: 'Fetch flight delay data from AviationStack' })
  @ApiQuery({ name: 'flight', required: true, description: 'IATA flight number (e.g. KQ100)' })
  @ApiQuery({ name: 'date', required: true, description: 'Flight date (YYYY-MM-DD)' })
  async getFlight(
    @Query('flight') flight: string,
    @Query('date')   date:   string,
  ) {
    const reading = await this.oracle.fetchFlightDelay(flight, date);
    return { success: true, data: { ...reading, value: reading.value.toString() } };
  }
}
