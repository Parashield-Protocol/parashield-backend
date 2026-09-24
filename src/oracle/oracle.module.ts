import { Module, MiddlewareConsumer, NestModule, RequestMethod } from '@nestjs/common';
import { OracleService, CircuitBreaker } from './oracle.service';
import { OracleController } from './oracle.controller';
import { OracleWorker }     from './oracle.worker';
import { OracleKeyValidationMiddleware } from './middleware/oracle-key-validation.middleware';
import { PrismaModule }     from '../prisma/prisma.module';
import { StellarModule }    from '../stellar/stellar.module';
import { AuthModule }       from '../auth/auth.module';

/**
 * #563 — Circuit breaker instances shared as module-level singletons so
 * re-instantiation of OracleService (e.g. in tests) preserves open/half-open
 * state instead of resetting the failure counter every time.
 */
const circuitBreakerProviders = [
  { provide: 'CIRCUIT_BREAKER_OPEN_METEO', useFactory: () => new CircuitBreaker('open-meteo', 5, 30_000) },
  { provide: 'CIRCUIT_BREAKER_AVIATIONSTACK', useFactory: () => new CircuitBreaker('aviationstack', 3, 60_000) },
];

@Module({
  imports:     [PrismaModule, StellarModule, AuthModule],
  controllers: [OracleController],
  providers:   [OracleService, OracleWorker, ...circuitBreakerProviders],
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
