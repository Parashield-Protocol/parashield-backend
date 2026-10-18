import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { UserThrottlerGuard } from './common/guards/user-throttler.guard';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PolicyModule }  from './policy/policy.module';
import { OracleModule }  from './oracle/oracle.module';
import { ClaimsModule }  from './claims/claims.module';
import { StellarModule } from './stellar/stellar.module';
import { PrismaModule }  from './prisma/prisma.module';
import { AuthModule }    from './auth/auth.module';
import { HealthModule }  from './health/health.module';
import { RedisModule }   from './redis/redis.module';
import { VersioningInterceptor } from './common/interceptors/versioning.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { BigIntSerializerInterceptor } from './common/interceptors/bigint-serializer.interceptor';
import { WebhooksModule } from './common/webhooks/webhooks.module';
import { validateJwtSecret } from './auth/jwt-secret.validator';
import { validateAllSecrets } from './common/secrets/secret-validator';
import { OpenTelemetryShutdownHook } from './common/telemetry/opentelemetry';

/**
 * Validate loaded environment configuration at startup.
 * Throws on missing or invalid required values.
 */
function validateConfig(config: Record<string, unknown>) {
  const errors: string[] = [];
  const logger = new Logger('ConfigValidation');

  // #343 — not a hard requirement (a localhost fallback is fine for local
  // dev), but the ThrottlerModule storage below falls back to it silently,
  // which is easy to miss in a real deployment that meant to point at a
  // shared Redis instance.
  if (!config['REDIS_URL']) {
    logger.warn('REDIS_URL is not set — falling back to redis://localhost:6379');
  }

  // #716 — Validate all secrets for length, format, entropy, and placeholders
  const nodeEnv = (config['NODE_ENV'] as string) || process.env.NODE_ENV || 'development';
  try {
    validateAllSecrets(config, nodeEnv);
  } catch (err) {
    errors.push((err as Error).message);
  }

  const jwtSecretValidation = validateJwtSecret(config['JWT_SECRET'] as string | undefined, nodeEnv);
  if (!jwtSecretValidation.valid) {
    errors.push(jwtSecretValidation.error!);
  }

  // #681 — Validate AUTH_NONCE_TTL_SECONDS if configured
  const nonceTtl = config['AUTH_NONCE_TTL_SECONDS'] as string | undefined;
  if (nonceTtl !== undefined && nonceTtl !== '') {
    const parsed = Number(nonceTtl);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 86400) {
      errors.push('AUTH_NONCE_TTL_SECONDS must be a positive integer between 1 and 86400');
    }
  }

  if (!config['DATABASE_URL']) {
    errors.push('DATABASE_URL is required');
  } else {
    // #669 — Validate DATABASE_URL format
    const dbUrl = config['DATABASE_URL'] as string;
    if (!dbUrl.startsWith('postgresql://') && !dbUrl.startsWith('postgres://')) {
      errors.push('DATABASE_URL must be a valid PostgreSQL connection string (postgresql:// or postgres://)');
    }
  }

  // #676 — Validate Prisma connection pool tuning environment variables
  const connLimit = config['DATABASE_CONNECTION_LIMIT'] as string | undefined;
  if (connLimit !== undefined && connLimit !== '') {
    const parsed = Number(connLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
      errors.push('DATABASE_CONNECTION_LIMIT must be a positive integer between 1 and 500');
    }
  }

  const poolTimeout = config['DATABASE_POOL_TIMEOUT'] as string | undefined;
  if (poolTimeout !== undefined && poolTimeout !== '') {
    const parsed = Number(poolTimeout);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 300) {
      errors.push('DATABASE_POOL_TIMEOUT must be a positive integer between 1 and 300');
    }
  }

  const connectTimeout = config['DATABASE_CONNECT_TIMEOUT'] as string | undefined;
  if (connectTimeout !== undefined && connectTimeout !== '') {
    const parsed = Number(connectTimeout);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 120) {
      errors.push('DATABASE_CONNECT_TIMEOUT must be a positive integer between 1 and 120');
    }
  }


  if (!config['STELLAR_RPC_URL']) {
    errors.push('STELLAR_RPC_URL is required');
  }

  if (!config['KEEPER_SECRET_KEY']) {
    errors.push('KEEPER_SECRET_KEY is required');
  }

  // #669 — Validate API keys are present
  const operatorApiKey = config['ORACLE_OPERATOR_API_KEY'] as string | undefined;
  const adminApiKey = config['ADMIN_API_KEY'] as string | undefined;
  if (!operatorApiKey && !adminApiKey) {
    errors.push('At least one of ORACLE_OPERATOR_API_KEY or ADMIN_API_KEY is required');
  }

  const claimsContract = config['CLAIMS_PROCESSOR_CONTRACT'] as string | undefined;
  if (claimsContract && !/^C[A-Z2-7]{55}$/.test(claimsContract)) {
    errors.push(
      'CLAIMS_PROCESSOR_CONTRACT must be a valid Stellar contract ID (C...)',
    );
  }

  const policyContract = config['POLICY_ENGINE_CONTRACT'] as string | undefined;
  if (policyContract && !/^C[A-Z2-7]{55}$/.test(policyContract)) {
    errors.push(
      'POLICY_ENGINE_CONTRACT must be a valid Stellar contract ID (C...)',
    );
  }

  // #669 — Validate CORS_ORIGIN is set and has no wildcards
  const corsOrigin = config['CORS_ORIGIN'] as string | undefined;
  if (!corsOrigin) {
    errors.push('CORS_ORIGIN is required');
  } else {
    const origins = corsOrigin.split(',').map((o) => o.trim()).filter(Boolean);
    if (origins.some((o) => o === '*' || o === 'null' || o.includes('*'))) {
      errors.push('CORS_ORIGIN must not contain wildcards (*)');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }

  return config;
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateConfig }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: 60000,
            limit: 60,
          },
        ],
        storage: new ThrottlerStorageRedisService(config.get<string>('REDIS_URL') || 'redis://localhost:6379'),
      }),
    }),
    RedisModule,
    PrismaModule,
    StellarModule,
    AuthModule,
    PolicyModule,
    OracleModule,
    ClaimsModule,
    HealthModule,
    WebhooksModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: UserThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: BigIntSerializerInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: VersioningInterceptor,
    },
    OpenTelemetryShutdownHook,
  ],
})
export class AppModule {}
