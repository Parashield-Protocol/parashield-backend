import { Module, MiddlewareConsumer, NestModule, RequestMethod } from '@nestjs/common';
import { AuthMiddleware }  from './auth.middleware';
import { AuthController }  from './auth.controller';
import { JwtService }      from './jwt.service';
import { JwtAuthGuard }    from './jwt-auth.guard';
import { OperatorAuthGuard } from './operator-auth.guard';

/**
 * AuthModule — provides Stellar wallet signature verification middleware and JWT issuance.
 *
 * Auth supports two request paths:
 *  - Wallet-header signatures for legacy clients on protected API routes.
 *  - JWT bearer tokens for the normal login flow via JwtAuthGuard.
 */
@Module({
  controllers: [AuthController],
  providers:   [AuthMiddleware, JwtService, JwtAuthGuard, OperatorAuthGuard],
  exports:     [AuthMiddleware, JwtService, JwtAuthGuard, OperatorAuthGuard],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .forRoutes(
        { path: 'policies/me', method: RequestMethod.GET },
        { path: 'policies/buy', method: RequestMethod.POST },
        { path: 'policies/confirm', method: RequestMethod.POST },
        { path: 'claims/submit', method: RequestMethod.POST },
        { path: 'claims/history/:wallet', method: RequestMethod.GET },
      );
  }
}
