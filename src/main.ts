import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { BigIntSerializerInterceptor } from './common/interceptors/bigint-serializer.interceptor';
import { ThrottleGuard } from './common/guards/throttle.guard';
import { JsonLogger } from './common/logging/json-logger.service';
import { SERVER_TIMEOUT_MS } from './common/middleware/request-timeout.middleware';
import { loadVaultSecrets } from './common/secrets/vault-secrets.loader';
import { applyRateLimitHeaders } from './common/swagger/rate-limit-headers';
import { API_DOCS } from './common/swagger/api-docs';
import { ErrorResponseDto } from './common/swagger/error-response.dto';
import { initializeOpenTelemetry } from './common/telemetry/opentelemetry';
import { parseTrustProxy } from './common/network/trust-proxy';
import { applySecurityHeaders } from './common/security/response-header-hardening';
import { createApiVersionMiddleware } from './common/versioning/api-version';
import compression from 'compression';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';
import { validateJwtSecret } from './auth/jwt-secret.validator';
import { validateAllSecrets } from './common/secrets/secret-validator';

const REQUEST_BODY_LIMIT = '1mb';

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
  // #496 — Vault runs before Nest (and its logger) exist. Fail fast with the
  // loader's explanation instead of an unhandled rejection, and never start
  // with secrets missing.
  try {
    await loadVaultSecrets();
  } catch (err) {
    new Logger('Bootstrap').error(`Fatal Error: ${(err as Error).message}`);
    process.exit(1);
  }
  await initializeOpenTelemetry();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // #352 — structured JSON logs instead of unstructured colored text, so a
  // log aggregator (CloudWatch/Datadog/Loki/etc.) can actually parse them.
  app.useLogger(new JsonLogger());
  const logger = new Logger('Bootstrap');

  const configService = app.get(ConfigService);
  const nodeEnv = configService.get<string>('NODE_ENV') || process.env.NODE_ENV || 'development';
  try {
    validateAllSecrets(process.env, nodeEnv);
  } catch (err) {
    logger.error(`Fatal Error: ${(err as Error).message}`);
    process.exit(1);
  }

  const jwtSecret = configService.get<string>('JWT_SECRET');
  const jwtSecretValidation = validateJwtSecret(jwtSecret, nodeEnv);
  if (!jwtSecretValidation.valid) {
    logger.error(`Fatal Error: ${jwtSecretValidation.error}`);
    process.exit(1);
  }

  // #494 — only honour X-Forwarded-For from explicitly trusted proxies, so
  // req.ip (used as the rate-limit and auth-lockout key) cannot be spoofed
  // by a client-supplied header. Defaults to trusting no proxies.
  app.set('trust proxy', parseTrustProxy(configService.get<string>('TRUST_PROXY')));

  // #671 — Framework-level JSON replacer for Express so any direct res.json calls
  // serialize BigInt values as decimal strings instead of throwing.
  app.set('json replacer', (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );

  // #713 — Stamp X-API-Version on every response as early as possible so it is
  // present even on responses that bypass the interceptor/exception-filter
  // pipeline (CORS preflights, timeouts, static docs).
  app.use(createApiVersionMiddleware());

  // Security headers (X-Content-Type-Options, X-Frame-Options, HSTS, etc.).
  // #711 — also disables Express's X-Powered-By and strips leaky headers such
  // as Server/X-Runtime/Via from every response.
  // #705 — HSTS is enabled to prevent SSL stripping attacks (see the helper).
  applySecurityHeaders(app);

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
    // #495 — tell the operator what a valid value looks like, not just that it's missing.
    logger.error(
      'Fatal Error: CORS_ORIGIN environment variable is required. ' +
      'Set it to the frontend origin(s) allowed to call the API, e.g. ' +
      'CORS_ORIGIN=http://localhost:3000 for local development, or a comma-separated ' +
      'list such as CORS_ORIGIN=https://app.example.com,https://staging.example.com. ' +
      'Wildcards (*) are not accepted. See .env.example and the README "CORS configuration" section.',
    );
    process.exit(1);
  }

  // #670 — Reject wildcard origins in all environments, including development.
  // A wildcard CORS origin allows any website to make authenticated requests
  // to the API, which is a security risk even in development (e.g., when using
  // cookies or tokens).
  const corsOrigins = corsOrigin.split(',').map((o) => o.trim()).filter(Boolean);
  const hasWildcard = corsOrigins.some((o) => o === '*' || o === 'null' || o.includes('*'));
  if (hasWildcard) {
    logger.error(
      'Fatal Error: CORS_ORIGIN must not contain wildcards (*). ' +
      'Specify exact origins instead, e.g. CORS_ORIGIN=http://localhost:3000. ' +
      'See .env.example and the README "CORS configuration" section.',
    );
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
    // #713 — let browser clients read the version/deprecation headers.
    exposedHeaders: ['X-API-Version', 'Deprecation', 'Link'],
  });

  app.setGlobalPrefix('api/v1');

  // Swagger docs at /docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle('ParaShield API')
    .setDescription(API_DOCS)
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

  const port = configService.get<number>('PORT') || 3001;
  const server = await app.listen(port);
  server.timeout = SERVER_TIMEOUT_MS;
  logger.log(`Parashield API running on http://localhost:${port}/api/v1`);
  logger.log(`Swagger docs available at http://localhost:${port}/docs`);
}
bootstrap().catch((err: unknown) => {
  new Logger('Bootstrap').error(`Fatal Error: ${(err as Error).message}`);
  process.exit(1);
});
