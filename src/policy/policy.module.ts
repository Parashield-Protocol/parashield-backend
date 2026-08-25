import { Module } from '@nestjs/common';
import { PolicyService }       from './policy.service';
import { PolicyController }    from './policy.controller';
import { PrismaModule }        from '../prisma/prisma.module';
import { StellarModule }       from '../stellar/stellar.module';
import { AuthModule }          from '../auth/auth.module';
import { StatusEventsService } from '../common/events/status-events.service';

@Module({
  imports:     [PrismaModule, StellarModule, AuthModule],
  controllers: [PolicyController],
  providers:   [PolicyService, StatusEventsService],
  exports:     [PolicyService, StatusEventsService],
})
export class PolicyModule {}
