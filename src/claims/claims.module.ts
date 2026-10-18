import { Module } from '@nestjs/common';
import { ClaimsService }    from './claims.service';
import { ClaimsController } from './claims.controller';
import { ClaimsWorker }     from './claims.worker';
import { PolicyStateCacheService } from './policy-state-cache.service';
import { PrismaModule }     from '../prisma/prisma.module';
import { OracleModule }     from '../oracle/oracle.module';
import { PolicyModule }     from '../policy/policy.module';
import { AuthModule }       from '../auth/auth.module';
import { WebhooksModule }   from '../common/webhooks/webhooks.module';

@Module({
  imports:     [PrismaModule, OracleModule, PolicyModule, AuthModule, WebhooksModule],
  controllers: [ClaimsController],
  providers:   [ClaimsService, ClaimsWorker, PolicyStateCacheService],
  exports:     [ClaimsService, PolicyStateCacheService],
})
export class ClaimsModule {}
