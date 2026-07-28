import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { BigIntSerializerInterceptor } from './common/interceptors/bigint-serializer.interceptor';
import { ThrottleGuard } from './common/guards/throttle.guard';
import helmet from 'helmet';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';

const REQUEST_BODY_LIMIT = '1mb';
const SERVER_TIMEOUT_MS = 30_000;

async function bootstrap() {
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
  if (!operatorApiKey) {
    logger.error('Fatal Error: ORACLE_OPERATOR_API_KEY environment variable is required');
    process.exit(1);
  }

  const parsedCorsOrigin = corsOrigin.includes(',')
    ? corsOrigin.split(',').map((o) => o.trim()).filter(Boolean)
    : corsOrigin.trim();

  // CORS
  app.enableCors({
    origin: parsedCorsOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-wallet-address', 'x-wallet-signature', 'x-wallet-message', 'x-api-key', 'x-admin-api-key'],
  });

  app.setGlobalPrefix('api/v1');

  // Swagger docs at /docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle('ParaShield API')
    .setDescription('Decentralized parametric insurance protocol on Stellar Soroban')
    .setVersion('1.0')
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
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  const port = configService.get<string>('PORT') ?? 3001;
  const server = await app.listen(port);
  server.timeout = SERVER_TIMEOUT_MS;
  logger.log(`Parashield API running on http://localhost:${port}/api/v1`);
  logger.log(`Swagger docs available at http://localhost:${port}/docs`);
}
bootstrap();
