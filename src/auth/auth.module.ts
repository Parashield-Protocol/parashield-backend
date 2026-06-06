import { Module, MiddlewareConsumer, NestModule, RequestMethod } from '@nestjs/common';
import { AuthMiddleware } from './auth.middleware';

/**
 * AuthModule — provides Stellar wallet signature verification middleware.
 *
 * The middleware is applied globally and attaches the verified wallet address
 * to req.wallet when auth headers are present.
 */
@Module({
  providers: [AuthMiddleware],
  exports:   [AuthMiddleware],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
