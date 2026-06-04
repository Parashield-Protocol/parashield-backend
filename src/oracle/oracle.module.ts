import { Module } from '@nestjs/common';
import { OracleService }    from './oracle.service';
import { OracleController } from './oracle.controller';
import { OracleWorker }     from './oracle.worker';
import { PrismaModule }     from '../prisma/prisma.module';
import { StellarModule }    from '../stellar/stellar.module';

@Module({
  imports:     [PrismaModule, StellarModule],
  controllers: [OracleController],
  providers:   [OracleService, OracleWorker],
  exports:     [OracleService],
})
export class OracleModule {}
