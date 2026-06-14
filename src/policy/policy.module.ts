import { Module } from '@nestjs/common';
import { PolicyService }    from './policy.service';
import { PolicyController } from './policy.controller';
import { PrismaModule }     from '../prisma/prisma.module';
import { StellarModule }    from '../stellar/stellar.module';

@Module({
  imports:     [PrismaModule, StellarModule],
  controllers: [PolicyController],
  providers:   [PolicyService],
  exports:     [PolicyService],
})
export class PolicyModule {}
