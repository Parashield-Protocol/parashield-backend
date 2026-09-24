import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { StreamingInterceptor } from "../common/interceptors/streaming.interceptor";
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
import { ApiErrorResponse } from "../common/swagger/api-error-responses";
import { Throttle } from "@nestjs/throttler";
import { OracleService } from "./oracle.service";
import {
  isValidOracleKeyFormat,
  ORACLE_KEY_FORMAT_DESCRIPTION,
} from "./oracle-key-format";
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
  @ApiResponse({ status: 404, description: "No reading found for the given key" })
  @ApiErrorResponse(400, 'The key does not match a recognized oracle key format.', undefined, 'Invalid oracle key format: "garbage". Expected rainfall:<lat>,<lng>:YYYY-MM, temperature:<lat>,<lng>:YYYY-MM, or flight:<code>:YYYY-MM-DD.')
  @ApiErrorResponse(404, 'No oracle reading found for the requested key.', undefined, 'No reading found for key: rainfall:-0.0917,34.7679:2026-06')
  @ApiErrorResponse(429, 'Rate limit exceeded (60 req / 60 s).', undefined, 'Too many requests. Please try again later.')
  async getReadingByKey(@Query("key") key: string) {
    const decoded = decodeURIComponent(key ?? "");
    if (!isValidOracleKeyFormat(decoded)) {
      throw new BadRequestException(
        `Invalid oracle key format: "${decoded}". Expected ${ORACLE_KEY_FORMAT_DESCRIPTION}.`,
      );
    }
    const reading = await this.oracle.getLatestReading(decoded);
    if (!reading) {
      throw new NotFoundException(`No reading found for key: ${decoded}`);
    }
    return {
      success: true,
      data: { ...reading, value: reading.value.toString() },
    };
  }

  /**
  * GET /api/v1/oracle/readings?page=...&limit=... — list all stored oracle readings
   *
   * PUBLIC ENDPOINT: No authentication required.
   * Oracle data is public and accessible to all users.
   *
   * Rate limited: 60 requests/minute per IP (global ThrottleGuard)
   *
   * #440 — supports NDJSON streaming to reduce peak memory for large result
   * sets. Pass `?stream=true` or `Accept: application/x-ndjson` to activate.
   */
  @Get("readings")
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @UseInterceptors(StreamingInterceptor)
  @ApiOperation({
    summary: "List all stored oracle readings",
    description:
      "Public endpoint. Returns latest oracle readings ordered by submission time (most recent first). " +
      "Pass `?stream=true` or `Accept: application/x-ndjson` to receive the data array as NDJSON (one item per line), " +
      "which reduces server memory usage for large result sets. " +
      "Rate limited to 60 requests/minute per IP.",
  })
  @ApiQuery({
    name: "page",
    required: false,
    description: "Page number (default 1)",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Max rows to return (default 100, max 500)",
  })
  @ApiQuery({
    name: "stream",
    required: false,
    description:
      "Set to 'true' to receive the response as NDJSON (one JSON object per line). " +
      "Alternatively send Accept: application/x-ndjson. " +
      "Pagination metadata is returned in X-Total-Count, X-Page, X-Limit headers.",
    example: "true",
  })
  @ApiResponse({ status: 200, description: "Array of oracle readings (JSON envelope) or NDJSON stream when ?stream=true", schema: { example: { success: true, data: [ { dataType: "weather", key: "rainfall:-0.0917,34.7679:2026-06", value: "324000000", confidence: 95, timestamp: 1719576600, source: "open-meteo" } ] } } })
  @ApiErrorResponse(429, 'Rate limit exceeded (60 req / 60 s).', undefined, 'Too many requests. Please try again later.')
  async getAllReadings(
    @Query("limit") limit?: string,
    @Query("page") page?: string,
  ) {
    const pageNumber = page ? Math.max(parseInt(page, 10) || 1, 1) : 1;
    const cap = limit ? Math.min(parseInt(limit, 10) || 100, 500) : 100;
    const readings = await this.oracle.getAllReadings(cap, pageNumber);
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
  @ApiResponse({ status: 404, description: "No reading found for the given key", })
  @ApiErrorResponse(400, 'The key does not match a recognized oracle key format.', undefined, 'Invalid oracle key format: "garbage". Expected rainfall:<lat>,<lng>:YYYY-MM, temperature:<lat>,<lng>:YYYY-MM, or flight:<code>:YYYY-MM-DD.')
  @ApiErrorResponse(404, 'No oracle reading found for the given key (path param).', undefined, 'No reading found for key: rainfall:-0.0917,34.7679:2026-06')
  @ApiErrorResponse(429, 'Rate limit exceeded (60 req / 60 s).', undefined, 'Too many requests. Please try again later.')
  async getLatestReading(@Param("key") key: string) {
    const reading = await this.oracle.getLatestReading(key);
    if (!reading) {
      throw new NotFoundException(`No reading found for key: ${key}`);
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
  @ApiResponse({ status: 201, description: "Returns the fetched oracle reading" })
  @ApiErrorResponse(401, 'Operator API key (x-api-key) or admin bearer token required.', undefined, 'Missing or invalid operator API key')
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
  @ApiResponse({ status: 201, description: "Returns the fetched oracle reading" })
  @ApiErrorResponse(401, 'Operator API key (x-api-key) or admin bearer token required.', undefined, 'Missing or invalid operator API key')
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
   * POST /api/v1/oracle/rainfall — fetch rainfall via query params
   *
   * AUTHENTICATED ENDPOINT: Requires operator API key or admin bearer token.
   * Changed from GET to POST to comply with HTTP semantics since this endpoint
   * mutates state by persisting data to the database.
   *
   * Rate limited: 60 requests/minute per IP (global ThrottleGuard)
   */
  @Post("rainfall")
  @UseGuards(OperatorAuthGuard)
  @ApiBearerAuth()
  @ApiSecurity("operator-api-key")
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({
    summary: "Fetch rainfall (query-param endpoint)",
    description:
      "Operator-only endpoint. Fetches rainfall data and persists to database. Requires x-api-key header with operator API key or Bearer JWT with admin role. Rate limited to 60 requests/minute per IP.",
  })
  @ApiQuery({ name: "lat", required: true, description: "Latitude, -90 to 90" })
  @ApiQuery({ name: "lng", required: true, description: "Longitude, -180 to 180" })
  @ApiQuery({ name: "year", required: true, description: "Year, 2000-2100" })
  @ApiQuery({ name: "month", required: true, description: "Month, 1-12" })
  @ApiResponse({ status: 200, description: "Rainfall reading" })
  @ApiErrorResponse(400, 'lat/lng/year/month failed validation.', undefined, 'lat must be a number between -90 and 90')
  @ApiErrorResponse(401, 'Operator API key (x-api-key) or admin bearer token required.', undefined, 'Missing or invalid operator API key')
  @ApiErrorResponse(429, 'Rate limit exceeded (60 req / 60 s).', undefined, 'Too many requests. Please try again later.')
  async getRainfall(
    @Query("lat") lat: string,
    @Query("lng") lng: string,
    @Query("year") year: string,
    @Query("month") month: string,
  ) {
    // #473 — these query params feed straight into the oracle key
    // (`rainfall:<lat>,<lng>:YYYY-MM`) and the upstream Open-Meteo request.
    // Unlike POST /oracle/fetch/rainfall (validated via OracleFeedRequestDto),
    // this query-param endpoint had no validation at all: an unparsable value
    // silently became NaN and produced a garbage key/request instead of a
    // clear 400.
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    // Number(), not parseInt(): parseInt("6.5", 10) truncates to 6 and would
    // silently accept a fractional year/month as valid.
    const yearNum = Number(year);
    const monthNum = Number(month);

    if (!Number.isFinite(latNum) || latNum < -90 || latNum > 90) {
      throw new BadRequestException('lat must be a number between -90 and 90');
    }
    if (!Number.isFinite(lngNum) || lngNum < -180 || lngNum > 180) {
      throw new BadRequestException('lng must be a number between -180 and 180');
    }
    if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
      throw new BadRequestException('year must be an integer between 2000 and 2100');
    }
    if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
      throw new BadRequestException('month must be an integer between 1 and 12');
    }

    const reading = await this.oracle.fetchRainfall(latNum, lngNum, yearNum, monthNum);
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
  @UseGuards(OperatorAuthGuard, AviationStackApiKeyGuard)
  @ApiBearerAuth()
  @ApiSecurity("operator-api-key")
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({
    summary: "Fetch flight delay data from AviationStack",
    description:
      "Operator-only endpoint. Requires x-api-key header with operator API key or Bearer JWT with admin role. Returns flight delay status for the specified flight and date. Rate limited to 60 requests/minute per IP.",
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
  @ApiResponse({ status: 200, description: "Flight delay reading" })
  @ApiErrorResponse(400, 'flight/date failed validation.', undefined, 'date must be in YYYY-MM-DD format')
  @ApiErrorResponse(401, 'Operator API key (x-api-key) or admin bearer token required.', undefined, 'Missing or invalid operator API key')
  @ApiErrorResponse(429, 'Rate limit exceeded (60 req / 60 s).', undefined, 'Too many requests. Please try again later.')
  async getFlight(
    @Query("flight") flight: string,
    @Query("date") date: string,
  ) {
    // #473 — these feed straight into the oracle key (`flight:<flight>:<date>`)
    // and the upstream AviationStack request; previously unvalidated.
    if (!flight || !/^[A-Z0-9]+$/.test(flight)) {
      throw new BadRequestException('flight must be an IATA flight number matching ^[A-Z0-9]+$');
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('date must be in YYYY-MM-DD format');
    }

    const reading = await this.oracle.fetchFlightDelay(flight, date);
    return {
      success: true,
      data: { ...reading, value: reading.value.toString() },
    };
  }
}
