import { Module } from '@nestjs/common';
import { ClaimsService }    from './claims.service';
import { ClaimsController } from './claims.controller';
import { ClaimsWorker }     from './claims.worker';
import { PrismaModule }     from '../prisma/prisma.module';
import { OracleModule }     from '../oracle/oracle.module';
import { PolicyModule }     from '../policy/policy.module';

@Module({
  imports:     [PrismaModule, OracleModule, PolicyModule],
  controllers: [ClaimsController],
  providers:   [ClaimsService, ClaimsWorker],
  exports:     [ClaimsService],
})
export class ClaimsModule {}
