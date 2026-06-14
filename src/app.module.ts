import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
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
    PrismaModule,
    StellarModule,
    AuthModule,
    PolicyModule,
    OracleModule,
    ClaimsModule,
    HealthModule,
  ],
})
export class AppModule {}
