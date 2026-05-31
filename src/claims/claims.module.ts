import { Module } from '@nestjs/common';
import { ClaimsService }    from './claims.service';
import { ClaimsController } from './claims.controller';
import { ClaimsWorker }     from './claims.worker';

@Module({
  controllers: [ClaimsController],
  providers:   [ClaimsService, ClaimsWorker],
  exports:     [ClaimsService],
})
export class ClaimsModule {}
