import { Module } from '@nestjs/common';
import { OracleService }    from './oracle.service';
import { OracleController } from './oracle.controller';
import { OracleWorker }     from './oracle.worker';

@Module({
  controllers: [OracleController],
  providers:   [OracleService, OracleWorker],
  exports:     [OracleService],
})
export class OracleModule {}
