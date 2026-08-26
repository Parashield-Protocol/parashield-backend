import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { BigIntSerializerInterceptor } from './common/interceptors/bigint-serializer.interceptor';
import { ThrottleGuard } from './common/guards/throttle.guard';
import { InputSanitizationMiddleware } from './common/middleware/input-sanitization.middleware';
import { RequestTimeoutMiddleware } from './common/middleware/request-timeout.middleware';
import { loadVaultSecrets } from './common/secrets/vault-secrets.loader';
import { initializeOpenTelemetry } from './common/telemetry/opentelemetry';
import helmet from 'helmet';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';

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
];

function parseCsvEnv(value: string | undefined): string[] | undefined {
  if (!value || !value.trim()) return undefined;
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

async function bootstrap() {
  await loadVaultSecrets();
  await initializeOpenTelemetry();
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  const configService = app.get(ConfigService);
  const jwtSecret = configService.get<string>('JWT_SECRET');
  if (!jwtSecret) {
    logger.error('Fatal Error: JWT_SECRET environment variable is required');
    process.exit(1);
  }

  // Security headers (X-Content-Type-Options, X-Frame-Options, HSTS, etc.)
  app.use(helmet());

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

  // Global exception filter
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Global interceptors
  app.useGlobalInterceptors(new LoggingInterceptor(), new BigIntSerializerInterceptor());

  // Global guards
  app.useGlobalGuards(new ThrottleGuard());

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
    .setDescription('Decentralized parametric insurance protocol on Stellar Soroban')
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
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  app.enableShutdownHooks();

  const port = configService.get<string>('PORT') ?? 3001;
  const server = await app.listen(port);
  server.timeout = SERVER_TIMEOUT_MS;
  logger.log(`Parashield API running on http://localhost:${port}/api/v1`);
  logger.log(`Swagger docs available at http://localhost:${port}/docs`);
}
bootstrap();
