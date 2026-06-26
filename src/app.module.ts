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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
