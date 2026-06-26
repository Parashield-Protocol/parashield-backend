import { Module, MiddlewareConsumer, NestModule, RequestMethod } from '@nestjs/common';
import { AuthMiddleware }  from './auth.middleware';
import { AuthController }  from './auth.controller';
import { JwtService }      from './jwt.service';
import { JwtAuthGuard }    from './jwt-auth.guard';

/**
 * AuthModule — provides Stellar wallet signature verification middleware and JWT issuance.
 *
 * The middleware is applied globally and attaches the verified wallet address
 * to req.wallet when auth headers are present.
 */
@Module({
  controllers: [AuthController],
  providers:   [AuthMiddleware, JwtService, JwtAuthGuard],
  exports:     [AuthMiddleware, JwtService, JwtAuthGuard],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
