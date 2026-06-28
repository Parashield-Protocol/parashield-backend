import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
  ApiSecurity,
  ApiExtraModels,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { OracleService } from "./oracle.service";
import { OracleFeedRequestDto } from "./dto/oracle-reading.dto";
import { OperatorAuthGuard } from "../auth/operator-auth.guard";
import { AviationStackApiKeyGuard } from "./guards/aviation-stack-api-key.guard";

@ApiTags("oracle")
@Controller("oracle")
@ApiExtraModels()
export class OracleController {
  constructor(private readonly oracle: OracleService) {}

  /**
   * GET /api/v1/oracle/reading?key=... — get the latest reading for an oracle key (query param)
   *
   * PUBLIC ENDPOINT: No authentication required.
   * Oracle data is public and accessible to all users.
   *
   * Rate limited: 60 requests/minute per IP (global ThrottleGuard)
   */
  @Get("reading")
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({
    summary: "Get the latest oracle reading for a given key (query param)",
    description:
      "Public endpoint. Returns the latest persisted oracle reading for the given key (e.g., rainfall:-0.0917,34.7679:2026-06). Rate limited to 60 requests/minute per IP.",
  })
  @ApiQuery({
    name: "key",
    required: true,
    description:
      "Oracle data key (e.g. rainfall:-0.0917,34.7679:2026-06, temperature:lat,lng:YYYY-MM, flight:IATA:YYYY-MM-DD)",
  })
  @ApiResponse({
    status: 200,
    description: "Latest oracle reading found",
    schema: {
      example: {
        success: true,
        data: {
          dataType: "weather",
          key: "rainfall:-0.0917,34.7679:2026-06",
          value: "324000000",
          confidence: 95,
          timestamp: 1719576600,
          source: "open-meteo",
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: "No reading found for key",
    schema: {
      example: {
        success: false,
        error: "No reading found for key: rainfall:-0.0917,34.7679:2026-06",
      },
    },
  })
  @ApiResponse({
    status: 429,
    description: "Rate limit exceeded (60 requests/minute per IP)",
  })
  async getReadingByKey(@Query("key") key: string) {
    const decoded = decodeURIComponent(key ?? "");
    const reading = await this.oracle.getLatestReading(decoded);
    if (!reading) {
      return { success: false, error: `No reading found for key: ${decoded}` };
    }
    return {
      success: true,
      data: { ...reading, value: reading.value.toString() },
    };
  }

  /**
   * GET /api/v1/oracle/readings?limit=... — list all stored oracle readings
   *
   * PUBLIC ENDPOINT: No authentication required.
   * Oracle data is public and accessible to all users.
   *
   * Rate limited: 60 requests/minute per IP (global ThrottleGuard)
   */
  @Get("readings")
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({
    summary: "List all stored oracle readings",
    description:
      "Public endpoint. Returns latest oracle readings ordered by submission time (most recent first). Rate limited to 60 requests/minute per IP.",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Max rows to return (default 100, max 500)",
  })
  @ApiResponse({
    status: 200,
    description: "Array of oracle readings",
    schema: {
      example: {
        success: true,
        data: [
          {
            dataType: "weather",
            key: "rainfall:-0.0917,34.7679:2026-06",
            value: "324000000",
            confidence: 95,
            timestamp: 1719576600,
            source: "open-meteo",
          },
        ],
      },
    },
  })
  @ApiResponse({
    status: 429,
    description: "Rate limit exceeded (60 requests/minute per IP)",
  })
  async getAllReadings(@Query("limit") limit?: string) {
    const cap = limit ? Math.min(parseInt(limit, 10) || 100, 500) : 100;
    const readings = await this.oracle.getAllReadings(cap);
    return {
      success: true,
      data: readings.map((r) => ({ ...r, value: r.value.toString() })),
    };
  }

  /**
   * GET /api/v1/oracle/latest/:key — get the latest reading for an oracle key (path param)
   *
   * PUBLIC ENDPOINT: No authentication required.
   * Oracle data is public and accessible to all users.
   * Uses path parameter instead of query string for cleaner URLs.
   *
   * Rate limited: 60 requests/minute per IP (global ThrottleGuard)
   */
  @Get("latest/:key")
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({
    summary: "Get the latest oracle reading for a given key (path param)",
    description:
      "Public endpoint. Returns the latest persisted oracle reading for the given key passed as a path parameter. Rate limited to 60 requests/minute per IP.",
  })
  @ApiParam({
    name: "key",
    description:
      "Oracle data key (e.g. rainfall:-0.0917,34.7679:2026-06, temperature:lat,lng:YYYY-MM, flight:IATA:YYYY-MM-DD)",
  })
  @ApiResponse({
    status: 200,
    description: "Latest oracle reading found",
    schema: {
      example: {
        success: true,
        data: {
          dataType: "weather",
          key: "rainfall:-0.0917,34.7679:2026-06",
          value: "324000000",
          confidence: 95,
          timestamp: 1719576600,
          source: "open-meteo",
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: "No reading found for key",
    schema: {
      example: {
        success: false,
        error: "No reading found for key: rainfall:-0.0917,34.7679:2026-06",
      },
    },
  })
  @ApiResponse({
    status: 429,
    description: "Rate limit exceeded (60 requests/minute per IP)",
  })
  async getLatestReading(@Param("key") key: string) {
    const reading = await this.oracle.getLatestReading(key);
    if (!reading) {
      return { success: false, error: `No reading found for key: ${key}` };
    }
    return {
      success: true,
      data: { ...reading, value: reading.value.toString() },
    };
  }

  /**
   * POST /api/v1/oracle/fetch/rainfall — trigger rainfall fetch
   *
   * OPERATOR ONLY: Requires either operator API key or admin JWT.
   * Fetches rainfall data from Open-Meteo and persists to database.
   */
  @Post("fetch/rainfall")
  @UseGuards(OperatorAuthGuard)
  @ApiBearerAuth()
  @ApiSecurity("operator-api-key")
  @ApiOperation({
    summary:
      "Operator-only: fetch rainfall data from Open-Meteo and persist to database",
    description:
      "Protected endpoint. Requires x-api-key header with operator API key or Bearer JWT with admin role. Fetches rainfall data for specified coordinates and month from Open-Meteo and persists to database.",
  })
  @ApiResponse({
    status: 201,
    description: "Returns the fetched oracle reading",
  })
  @ApiResponse({
    status: 401,
    description: "Operator API key or admin bearer token required",
  })
  async fetchRainfall(@Body() dto: OracleFeedRequestDto) {
    const reading = await this.oracle.fetchRainfall(
      dto.lat,
      dto.lng,
      dto.year,
      dto.month,
    );
    return {
      success: true,
      data: { ...reading, value: reading.value.toString() },
    };
  }

  /**
   * POST /api/v1/oracle/fetch/temperature — trigger temperature fetch
   *
   * OPERATOR ONLY: Requires either operator API key or admin JWT.
   * Fetches temperature data from Open-Meteo and persists to database.
   */
  @Post("fetch/temperature")
  @UseGuards(OperatorAuthGuard)
  @ApiBearerAuth()
  @ApiSecurity("operator-api-key")
  @ApiOperation({
    summary:
      "Operator-only: fetch temperature data from Open-Meteo and persist to database",
    description:
      "Protected endpoint. Requires x-api-key header with operator API key or Bearer JWT with admin role. Fetches temperature data for specified coordinates and month from Open-Meteo and persists to database.",
  })
  @ApiResponse({
    status: 201,
    description: "Returns the fetched oracle reading",
  })
  @ApiResponse({
    status: 401,
    description: "Operator API key or admin bearer token required",
  })
  async fetchTemperature(@Body() dto: OracleFeedRequestDto) {
    const reading = await this.oracle.fetchTemperature(
      dto.lat,
      dto.lng,
      dto.year,
      dto.month,
    );
    return {
      success: true,
      data: { ...reading, value: reading.value.toString() },
    };
  }

  /**
   * GET /api/v1/oracle/rainfall — legacy: fetch rainfall via query params
   *
   * PUBLIC ENDPOINT: No authentication required.
   * Legacy endpoint. Use POST /fetch/rainfall for operator-only functionality.
   *
   * Rate limited: 60 requests/minute per IP (global ThrottleGuard)
   */
  @Get("rainfall")
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({
    summary: "Fetch rainfall (legacy query-param endpoint)",
    description:
      "Public endpoint. Legacy endpoint for fetching rainfall data. Rate limited to 60 requests/minute per IP.",
  })
  @ApiQuery({ name: "lat", required: true, description: "Latitude" })
  @ApiQuery({ name: "lng", required: true, description: "Longitude" })
  @ApiQuery({ name: "year", required: true, description: "Year (YYYY)" })
  @ApiQuery({ name: "month", required: true, description: "Month (1-12)" })
  @ApiResponse({
    status: 200,
    description: "Rainfall reading",
  })
  @ApiResponse({
    status: 429,
    description: "Rate limit exceeded (60 requests/minute per IP)",
  })
  async getRainfall(
    @Query("lat") lat: string,
    @Query("lng") lng: string,
    @Query("year") year: string,
    @Query("month") month: string,
  ) {
    const reading = await this.oracle.fetchRainfall(
      parseFloat(lat),
      parseFloat(lng),
      parseInt(year),
      parseInt(month),
    );
    return {
      success: true,
      data: { ...reading, value: reading.value.toString() },
    };
  }

  /**
   * GET /api/v1/oracle/flight — fetch flight delay status
   *
   * PROTECTED ENDPOINT: Requires AviationStack API key.
   * Fetches flight delay data from AviationStack.
   *
   * Rate limited: 60 requests/minute per IP (global ThrottleGuard)
   */
  @Get("flight")
  @UseGuards(AviationStackApiKeyGuard)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({
    summary: "Fetch flight delay data from AviationStack",
    description:
      "Protected endpoint. Requires valid AviationStack API key. Returns flight delay status for the specified flight and date. Rate limited to 60 requests/minute per IP.",
  })
  @ApiQuery({
    name: "flight",
    required: true,
    description: "IATA flight number (e.g. KQ100, BA747)",
  })
  @ApiQuery({
    name: "date",
    required: true,
    description: "Flight date (YYYY-MM-DD)",
  })
  @ApiResponse({
    status: 200,
    description: "Flight delay reading",
  })
  @ApiResponse({
    status: 401,
    description: "Invalid AviationStack API key",
  })
  @ApiResponse({
    status: 429,
    description: "Rate limit exceeded (60 requests/minute per IP)",
  })
  async getFlight(
    @Query("flight") flight: string,
    @Query("date") date: string,
  ) {
    const reading = await this.oracle.fetchFlightDelay(flight, date);
    return {
      success: true,
      data: { ...reading, value: reading.value.toString() },
    };
  }
}
