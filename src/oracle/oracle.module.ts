import { Module, MiddlewareConsumer, NestModule, RequestMethod } from '@nestjs/common';
import { OracleService }    from './oracle.service';
import { OracleController } from './oracle.controller';
import { OracleWorker }     from './oracle.worker';
import { OracleKeyValidationMiddleware } from './middleware/oracle-key-validation.middleware';
import { PrismaModule }     from '../prisma/prisma.module';
import { StellarModule }    from '../stellar/stellar.module';
import { AuthModule }       from '../auth/auth.module';

@Module({
  imports:     [PrismaModule, StellarModule, AuthModule],
  controllers: [OracleController],
  providers:   [OracleService, OracleWorker],
  exports:     [OracleService],
})
export class OracleModule implements NestModule {
  // #473 — reject malformed oracle keys before they reach the controller.
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(OracleKeyValidationMiddleware)
      .forRoutes(
        { path: 'oracle/reading', method: RequestMethod.GET },
        { path: 'oracle/latest/:key', method: RequestMethod.GET },
      );
  }
}
