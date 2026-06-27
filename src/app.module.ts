import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { APP_GUARD } from '@nestjs/core';
import { PolicyModule }  from './policy/policy.module';
import { OracleModule }  from './oracle/oracle.module';
import { ClaimsModule }  from './claims/claims.module';
import { StellarModule } from './stellar/stellar.module';
import { PrismaModule }  from './prisma/prisma.module';
import { AuthModule }    from './auth/auth.module';
import { HealthModule }  from './health/health.module';

/**
 * Validate loaded environment configuration at startup.
 * Throws on missing or invalid required values.
 */
function validateConfig(config: Record<string, unknown>) {
  const errors: string[] = [];

  if (!config['JWT_SECRET']) {
    errors.push('JWT_SECRET is required');
  }

  const claimsContract = config['CLAIMS_PROCESSOR_CONTRACT'] as string | undefined;
  if (claimsContract && !/^C[A-Z2-7]{55}$/.test(claimsContract)) {
    errors.push(
      'CLAIMS_PROCESSOR_CONTRACT must be a valid Stellar contract ID (C...)',
    );
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
    PrismaModule,
    StellarModule,
    AuthModule,
    PolicyModule,
    OracleModule,
    ClaimsModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
