import { Module } from '@nestjs/common';
import { ClaimsService }    from './claims.service';
import { ClaimsController } from './claims.controller';
import { ClaimsWorker }     from './claims.worker';
import { PrismaModule }     from '../prisma/prisma.module';

@Module({
  imports:     [PrismaModule],
  controllers: [ClaimsController],
  providers:   [ClaimsService, ClaimsWorker],
  exports:     [ClaimsService],
})
export class ClaimsModule {}
