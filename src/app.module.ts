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
import { WebhooksModule } from './common/webhooks/webhooks.module';

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

  if (!config['JWT_SECRET']) {
    errors.push('JWT_SECRET is required');
  } else if ((config['JWT_SECRET'] as string).length < 32) {
    errors.push('JWT_SECRET must be at least 32 bytes (256 bits) for production security');
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
      useClass: VersioningInterceptor,
    },
  ],
})
export class AppModule {}
