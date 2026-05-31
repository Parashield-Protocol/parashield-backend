import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PolicyModule }  from './policy/policy.module';
import { OracleModule }  from './oracle/oracle.module';
import { ClaimsModule }  from './claims/claims.module';
import { StellarModule } from './stellar/stellar.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    StellarModule,
    PolicyModule,
    OracleModule,
    ClaimsModule,
  ],
})
export class AppModule {}
