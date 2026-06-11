import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global exception filter
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Global interceptors
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Global validation pipe
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // CORS
  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-wallet-address', 'x-wallet-signature', 'x-wallet-message'],
  });

  app.setGlobalPrefix('api/v1');

  // Swagger docs at /docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle('ParaShield API')
    .setDescription('Decentralized parametric insurance protocol on Stellar Soroban')
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('policy', 'Insurance product and policy management')
    .addTag('claims', 'Claim submission and processing')
    .addTag('oracle', 'Oracle data feeds and readings')
    .addTag('auth', 'Wallet-based authentication')
    .addTag('health', 'Service health monitoring')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`Parashield API running on http://localhost:${port}/api/v1`);
  console.log(`Swagger docs available at http://localhost:${port}/docs`);
}
bootstrap();
