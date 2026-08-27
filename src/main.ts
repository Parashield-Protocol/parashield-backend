import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { BigIntSerializerInterceptor } from './common/interceptors/bigint-serializer.interceptor';
import { ThrottleGuard } from './common/guards/throttle.guard';
import { JsonLogger } from './common/logging/json-logger.service';
import { InputSanitizationMiddleware } from './common/middleware/input-sanitization.middleware';
import { RequestTimeoutMiddleware } from './common/middleware/request-timeout.middleware';
import { UsdcPrecisionValidationMiddleware } from './common/middleware/usdc-precision-validation.middleware';
import { IdempotencyMiddleware } from './common/middleware/idempotency.middleware';
import { loadVaultSecrets } from './common/secrets/vault-secrets.loader';
import { applyRateLimitHeaders } from './common/swagger/rate-limit-headers';
import { REALTIME_DOCS } from './common/swagger/realtime-docs';
import { ErrorResponseDto } from './common/swagger/error-response.dto';
import { initializeOpenTelemetry } from './common/telemetry/opentelemetry';
import helmet from 'helmet';
import compression from 'compression';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';
import Redis from 'ioredis';

const REQUEST_BODY_LIMIT = '1mb';
const SERVER_TIMEOUT_MS = 30_000;

// #382 — CORS defaults, kept identical to the previously hardcoded values.
// Each can be overridden via env vars (see .env.example and README).
const DEFAULT_CORS_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
const DEFAULT_CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'x-wallet-address',
  'x-wallet-signature',
  'x-wallet-message',
  'x-api-key',
  'x-admin-api-key',
  'Idempotency-Key',
];

function parseCsvEnv(value: string | undefined): string[] | undefined {
  if (!value || !value.trim()) return undefined;
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

async function bootstrap() {
  await loadVaultSecrets();
  await initializeOpenTelemetry();
  const app = await NestFactory.create(AppModule);
  // #352 — structured JSON logs instead of unstructured colored text, so a
  // log aggregator (CloudWatch/Datadog/Loki/etc.) can actually parse them.
  app.useLogger(new JsonLogger());
  const logger = new Logger('Bootstrap');

  const configService = app.get(ConfigService);
  const jwtSecret = configService.get<string>('JWT_SECRET');
  if (!jwtSecret) {
    logger.error('Fatal Error: JWT_SECRET environment variable is required');
    process.exit(1);
  }

  // Security headers (X-Content-Type-Options, X-Frame-Options, HSTS, etc.)
  app.use(helmet());

  // Response compression — gzip/deflate for text-based responses (JSON, HTML,
  // SSE streams). Runs before route handlers so every response is eligible.
  // Threshold of 1 KB avoids compressing tiny payloads where the overhead
  // outweighs the savings. Clients that do not send Accept-Encoding are served
  // uncompressed transparently. Overridable via COMPRESSION_LEVEL (0-9, default 6)
  // and COMPRESSION_THRESHOLD_BYTES (default 1024) without code changes.
  const compressionLevel = parseInt(configService.get<string>('COMPRESSION_LEVEL') ?? '6', 10);
  const compressionThreshold = parseInt(configService.get<string>('COMPRESSION_THRESHOLD_BYTES') ?? '1024', 10);
  app.use(
    compression({
      level: compressionLevel,
      threshold: compressionThreshold,
      // Compress all compressible content types (JSON, text, SSE, etc.)
      filter: (req, res) => {
        // Honour the caller's explicit opt-out via Cache-Control: no-transform
        const cacheControl = res.getHeader('Cache-Control');
        if (typeof cacheControl === 'string' && cacheControl.includes('no-transform')) {
          return false;
        }
        return compression.filter(req, res);
      },
    }),
  );

  // Explicit request body size limit (defaults are implicit and adapter-dependent)
  app.use(json({ limit: REQUEST_BODY_LIMIT }));
  app.use(urlencoded({ limit: REQUEST_BODY_LIMIT, extended: true }));

  // #409 — per-request application-level timeout. Responds with 408 and
  // destroys the socket if a handler does not complete within SERVER_TIMEOUT_MS.
  // This is distinct from server.timeout (set later), which is a TCP idle timeout.
  const requestTimeout = new RequestTimeoutMiddleware(SERVER_TIMEOUT_MS);
  app.use((req, res, next) => requestTimeout.use(req, res, next));

  // #380 — sanitize user-provided strings in request bodies (trim + escape
  // angle brackets) before validation and persistence. Runs on the Express
  // adapter after the body parsers so every route is covered.
  const sanitizer = new InputSanitizationMiddleware();
  app.use((req, res, next) => sanitizer.use(req, res, next));

  // #465 — validate USDC amount precision (7 decimal places max) before
  // validation and persistence. Prevents contract errors from amounts with
  // excessive precision that don't match Stellar asset constraints.
  const usdcValidator = new UsdcPrecisionValidationMiddleware();
  app.use((req, res, next) => usdcValidator.use(req, res, next));

  // #438 — idempotency key deduplication for mutating requests (POST/PUT/PATCH).
  // Clients include an `Idempotency-Key` header; replayed requests with the
  // same key get the cached response instead of re-executing the handler.
  const redisClient = app.get<Redis>('REDIS_CLIENT');
  const idempotency = new IdempotencyMiddleware(redisClient);
  app.use((req, res, next) => idempotency.use(req, res, next));

  // Global exception filter
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Global interceptors
  app.useGlobalInterceptors(new LoggingInterceptor(), new BigIntSerializerInterceptor());

  // Global guards
  // REMOVED: app.useGlobalGuards(new ThrottleGuard());
  // Issue #325: Duplicate rate limiting removed. ThrottlerGuard (Redis-backed) is already
  // registered globally in app.module.ts via APP_GUARD provider. The custom ThrottleGuard
  // (in-memory Map) was causing conflicting counts in multi-instance deployments.

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  const corsOrigin = configService.get<string>('CORS_ORIGIN');
  if (!corsOrigin) {
    logger.error('Fatal Error: CORS_ORIGIN environment variable is required');
    process.exit(1);
  }

  const operatorApiKey = configService.get<string>('ORACLE_OPERATOR_API_KEY');
  const adminApiKey = configService.get<string>('ADMIN_API_KEY');
  
  if (!operatorApiKey && !adminApiKey) {
    logger.error('Fatal Error: At least one of ORACLE_OPERATOR_API_KEY or ADMIN_API_KEY environment variables is required');
    process.exit(1);
  }

  const parsedCorsOrigin = corsOrigin.includes(',')
    ? corsOrigin.split(',').map((o) => o.trim()).filter(Boolean)
    : corsOrigin.trim();

  // #382 — CORS. CORS_ORIGIN is required and validated above (a single origin
  // or a comma-separated list). Methods, allowed headers, and credentials can
  // be tuned via env vars without code changes:
  //   CORS_METHODS          comma-separated list   (default GET,POST,PUT,DELETE,OPTIONS)
  //   CORS_ALLOWED_HEADERS  comma-separated list   (default: the headers below)
  //   CORS_CREDENTIALS      "true" enables cookies/credentials (default false)
  // Full documentation in README.md ("CORS configuration") and .env.example.
  const corsMethods = parseCsvEnv(configService.get<string>('CORS_METHODS')) ?? DEFAULT_CORS_METHODS;
  const corsAllowedHeaders = parseCsvEnv(configService.get<string>('CORS_ALLOWED_HEADERS')) ?? DEFAULT_CORS_ALLOWED_HEADERS;
  const corsCredentials = configService.get<string>('CORS_CREDENTIALS')?.trim().toLowerCase() === 'true';

  // CORS
  app.enableCors({
    origin: parsedCorsOrigin,
    methods: corsMethods,
    allowedHeaders: corsAllowedHeaders,
    credentials: corsCredentials,
  });

  app.setGlobalPrefix('api/v1');

  // Swagger docs at /docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle('ParaShield API')
    .setDescription(
      'Decentralized parametric insurance protocol on Stellar Soroban\n\n' +
      '## Rate Limiting\n\n' +
      'All endpoints are protected by a rate limiter applied per client IP address. Most ' +
      'endpoints use the app-wide default below, but a few sensitive endpoints enforce a ' +
      'tighter, endpoint-specific window — check that endpoint\'s own 429 response ' +
      'description (below in this doc) for its exact limit and reset window.\n\n' +
      '| Parameter | Value |\n' +
      '|-----------|-------|\n' +
      '| Window    | 60 seconds (default) |\n' +
      '| Limit     | 60 requests per window (default) |\n' +
      '| Scope     | Per IP address (uses `X-Forwarded-For` when behind a proxy) |\n\n' +
      '| Endpoint | Window | Limit |\n' +
      '|----------|--------|-------|\n' +
      '| `POST /auth/challenge`, `POST /auth/login` | 60 seconds | 10 requests |\n' +
      '| `POST /claims` | 60 seconds | 5 requests |\n' +
      '| All other endpoints | 60 seconds | 60 requests |\n\n' +
      '### Response headers\n\n' +
      'Every response includes the following headers so clients can track their current usage. ' +
      '`X-RateLimit-Limit` and `X-RateLimit-Reset` reflect the window of the specific endpoint ' +
      'called, not always the app-wide default:\n\n' +
      '| Header | Description |\n' +
      '|--------|-------------|\n' +
      '| `X-RateLimit-Limit` | Maximum requests allowed in the current window for this endpoint |\n' +
      '| `X-RateLimit-Remaining` | Requests remaining before the limit is hit |\n' +
      '| `X-RateLimit-Reset` | Unix timestamp (seconds) at which this endpoint\'s window resets |\n\n' +
      '### Exceeded limit — 429 Too Many Requests\n\n' +
      'When the limit is exceeded the API responds with HTTP **429** and an additional ' +
      '`Retry-After` header indicating how many seconds to wait before retrying.\n\n' +
      '```json\n' +
      '{\n' +
      '  "success": false,\n' +
      '  "errorCode": "TOO_MANY_REQUESTS",\n' +
      '  "error": "Too many requests. Please try again later.",\n' +
      '  "statusCode": 429,\n' +
      '  "retryAfter": 42\n' +
      '}\n' +
      '```\n\n' +
      '## Request Timeouts\n\n' +
      'Every request is subject to a fixed processing timeout, enforced at two layers that share ' +
      'the same 30-second value:\n\n' +
      '| Layer | Behavior |\n' +
      '|-------|----------|\n' +
      '| Application middleware | Starts a timer when the request enters the handler chain. If no response has been sent after 30 seconds, it responds **408 Request Timeout** and closes the underlying connection so the server slot is freed immediately. |\n' +
      '| HTTP server socket | A 30-second idle timeout on the underlying Node HTTP server, as a fallback in case the application-level timer is bypassed. |\n\n' +
      'The timeout window is currently a fixed 30 seconds — it is not configurable via an environment ' +
      'variable — and applies uniformly to every route; there is no per-endpoint override.\n\n' +
      '### 408 response body\n\n' +
      'The 408 response is written directly by the timeout middleware before the request reaches ' +
      'route handling, so — unlike every other error response documented here — it does **not** use ' +
      'the standard error envelope (no `success`, `errorCode`, `path`, or `timestamp` fields):\n\n' +
      '```json\n' +
      '{\n' +
      '  "statusCode": 408,\n' +
      '  "error": "Request Timeout",\n' +
      '  "message": "The request exceeded the maximum allowed processing time."\n' +
      '}\n' +
      '```\n\n' +
      '### Handling 408s\n\n' +
      'A 408 means the handler was still running past the 30-second window, not that the request was ' +
      'necessarily rejected before doing any work. Treat it as retryable following the same guidance as ' +
      '`SERVICE_UNAVAILABLE` above (exponential backoff; for mutating `POST`/`PUT`/`PATCH` requests, ' +
      'resend the same `Idempotency-Key` so a request that actually completed server-side is not ' +
      're-executed).\n\n' +
      '## Pagination\n\n' +
      'List endpoints that return more than a handful of rows accept `page` and `limit` query ' +
      'parameters and return a paginated envelope instead of a bare array:\n\n' +
      '| Parameter | Type | Default | Notes |\n' +
      '|-----------|------|---------|-------|\n' +
      '| `page`    | integer | `1`  | 1-based. Values below 1 are clamped up to 1. |\n' +
      '| `limit`   | integer | `20` | Clamped to the range `1`-`100`; values outside that range are clamped, not rejected. |\n\n' +
      '```json\n' +
      '{\n' +
      '  "success": true,\n' +
      '  "data": [ /* items for this page */ ],\n' +
      '  "total": 42,\n' +
      '  "page": 1,\n' +
      '  "limit": 20\n' +
      '}\n' +
      '```\n\n' +
      '| Field   | Description |\n' +
      '|---------|-------------|\n' +
      '| `data`  | Array of items for the requested page |\n' +
      '| `total` | Total number of items across all pages |\n' +
      '| `page`  | The page number this response corresponds to |\n' +
      '| `limit` | The page size this response used |\n\n' +
      'Paginated endpoints: `GET /products`, `GET /policies/me`, `GET /claims`, `GET /claims/history/{wallet}`. ' +
      'Some of these also support `?stream=true` (NDJSON, one item per line) as an alternative to the ' +
      'paginated JSON envelope for large result sets — see that endpoint\'s own `stream` parameter ' +
      'description for details; pagination metadata is then returned via the `X-Total-Count`, `X-Page`, ' +
      'and `X-Limit` response headers instead of the JSON body.\n\n' +
      '## Error Response Structure\n\n' +
      'All error responses follow a consistent envelope format for reliable parsing:\n\n' +
      '```json\n' +
      '{\n' +
      '  "success": false,\n' +
      '  "errorCode": "NOT_FOUND",\n' +
      '  "error": "Policy not found",\n' +
      '  "statusCode": 404,\n' +
      '  "path": "/api/v1/policies/abc123",\n' +
      '  "timestamp": "2024-01-15T10:30:00.000Z"\n' +
      '}\n' +
      '```\n\n' +
      '### Error Response Fields\n\n' +
      '| Field | Type | Description |\n' +
      '|-------|------|-------------|\n' +
      '| `success` | `boolean` | Always `false` for errors |\n' +
      '| `errorCode` | `string` | Stable machine-readable code (see table below) - key off this, not `error` |\n' +
      '| `error` | `string` or `object` | Human-readable message, or validation error details for 400s. May change between versions |\n' +
      '| `statusCode` | `number` | HTTP status code |\n' +
      '| `path` | `string` | The request path that produced the error |\n' +
      '| `timestamp` | `string` | ISO-8601 UTC timestamp |\n' +
      '| `retryAfter` | `number` | (Optional) Seconds to wait before retrying - present only on 429 responses |\n\n' +
      '### Error Codes Reference\n\n' +
      '| `errorCode` | HTTP Status | When It Occurs |\n' +
      '|-------------|-------------|----------------|\n' +
      '| `VALIDATION_ERROR` | 400 | Request body fails validation rules (missing/invalid fields, wrong types). The `error` field contains validation details |\n' +
      '| `BAD_REQUEST` | 400 | Generic bad request not covered by validation (malformed path param, unsupported value, USDC precision errors) |\n' +
      '| `UNAUTHORIZED` | 401 | Missing or invalid JWT / wallet signature. Include `Authorization: Bearer <token>` or valid wallet headers |\n' +
      '| `FORBIDDEN` | 403 | Authenticated but not allowed (e.g. accessing another wallet\'s policy, calling operator-only endpoint without API key) |\n' +
      '| `NOT_FOUND` | 404 | Resource does not exist (policy ID, claim ID, oracle key, etc.) |\n' +
      '| `CONFLICT` | 409 | Duplicate resource (e.g. submitting a claim when one is already active for the same policy) |\n' +
      '| `GONE` | 410 | Resource existed but is no longer accessible (e.g. expired policy) |\n' +
      '| `TOO_MANY_REQUESTS` | 429 | Rate limit exceeded (60 requests per minute per IP). Back off and retry after the `retryAfter` value |\n' +
      '| `INTERNAL_ERROR` | 500 | Unexpected server failure. Logged server-side; response omits internal details |\n' +
      '| `SERVICE_UNAVAILABLE` | 503 | Downstream dependency unavailable (database, Redis, Stellar RPC) |\n\n' +
      '## Error Recovery\n\n' +
      'Guidance for programmatically recovering from each error, keyed off `errorCode` ' +
      '(not the human-readable `error` message, which may change between versions):\n\n' +
      '| `errorCode` | Retryable | Recommended recovery |\n' +
      '|-------------|-----------|----------------------|\n' +
      '| `VALIDATION_ERROR` | No | Fix the request body per the validation details in `error`, then resend |\n' +
      '| `BAD_REQUEST` | No | Correct the malformed field/value indicated in `error`, then resend |\n' +
      '| `UNAUTHORIZED` | No | Re-authenticate (refresh the JWT or re-sign the wallet challenge), then resend |\n' +
      '| `FORBIDDEN` | No | Not recoverable by retrying — the caller lacks permission for this resource/action |\n' +
      '| `NOT_FOUND` | No | Verify the ID/path is correct; do not retry against the same path |\n' +
      '| `CONFLICT` | No | Fetch current state first (e.g. existing claim) before deciding whether to resend |\n' +
      '| `GONE` | No | Resource is permanently inaccessible; stop retrying |\n' +
      '| `TOO_MANY_REQUESTS` | Yes | Wait `retryAfter` seconds (from the body) before retrying once |\n' +
      '| `INTERNAL_ERROR` | Yes | Retry with exponential backoff; escalate if it persists across retries |\n' +
      '| `SERVICE_UNAVAILABLE` | Yes | Retry with exponential backoff; check `/api/v1/health` to confirm dependency recovery |\n\n' +
      '### Retry strategy\n\n' +
      'For the retryable errors above (`TOO_MANY_REQUESTS`, `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`):\n\n' +
      '1. Respect `retryAfter` / `Retry-After` when present instead of retrying immediately.\n' +
      '2. Otherwise back off exponentially (e.g. 1s, 2s, 4s, 8s) with jitter, capped at a small number of attempts.\n' +
      '3. For mutating requests (`POST`/`PUT`/`PATCH`), send the same `Idempotency-Key` header on every retry so a ' +
      'request that actually succeeded server-side but timed out on the client is not re-executed — the API replays ' +
      'the cached response (marked with `X-Idempotent-Replayed: true`) instead of processing it twice. Idempotency ' +
      'keys are cached for 24 hours.\n' +
      '4. Give up and surface the error to the caller once retries are exhausted; non-retryable errors ' +
      '(`VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `GONE`, `BAD_REQUEST`) should ' +
      'never be retried unmodified — they will fail identically every time.\n\n' +
      '### Validation Errors (400)\n\n' +
      'When class-validator rejects a request body, the `error` field contains detailed constraint violations:\n\n' +
      '```json\n' +
      '{\n' +
      '  "success": false,\n' +
      '  "errorCode": "VALIDATION_ERROR",\n' +
      '  "error": {\n' +
      '    "message": ["wallet must be a string", "productId should not be empty"],\n' +
      '    "error": "Bad Request",\n' +
      '    "statusCode": 400\n' +
      '  },\n' +
      '  "statusCode": 400,\n' +
      '  "path": "/api/v1/policies/buy",\n' +
      '  "timestamp": "2024-01-15T10:30:00.000Z"\n' +
      '}\n' +
      '```\n\n' +
      '### USDC Precision Validation\n\n' +
      'All monetary amounts must conform to Stellar USDC precision (7 decimal places maximum). ' +
      'Requests with excessive precision are rejected with `BAD_REQUEST`:\n\n' +
      '```json\n' +
      '{\n' +
      '  "success": false,\n' +
      '  "errorCode": "BAD_REQUEST",\n' +
      '  "error": "Amount precision at amount exceeds Stellar USDC limit. Maximum 7 decimal places allowed, found 8. Value: \\"10.12345678\\"",\n' +
      '  "statusCode": 400,\n' +
      '  "path": "/api/v1/policies/buy",\n' +
      '  "timestamp": "2024-01-15T10:30:00.000Z"\n' +
      '}\n' +
      '```' +
      REALTIME_DOCS,
    )
    .setVersion('1.0')
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-version',
        description: 'API version (defaults to v1)',
      },
      'x-api-version',
    )
    .addBearerAuth()
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'Operator API key for admin-only oracle fetch endpoints',
      },
      'operator-api-key',
    )
    .addTag('policy', 'Insurance product and policy management')
    .addTag('claims', 'Claim submission and processing')
    .addTag('oracle', 'Oracle data feeds and readings')
    .addTag('auth', 'Wallet-based authentication')
    .addTag('health', 'Service health monitoring')
    .addTag('webhooks', 'Webhook registration and real-time event subscriptions')
    .addTag('events', 'Server-Sent Events (SSE) for real-time policy status streaming')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig, {
    extraModels: [ErrorResponseDto],
  });
  applyRateLimitHeaders(document);
  SwaggerModule.setup('docs', app, document);

  app.enableShutdownHooks();

  const port = configService.get<string>('PORT') ?? 3001;
  const server = await app.listen(port);
  server.timeout = SERVER_TIMEOUT_MS;
  logger.log(`Parashield API running on http://localhost:${port}/api/v1`);
  logger.log(`Swagger docs available at http://localhost:${port}/docs`);
}
bootstrap();
