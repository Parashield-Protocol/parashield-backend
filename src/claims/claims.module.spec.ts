import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ClaimsModule } from './claims.module';
import { ClaimsService } from './claims.service';
import { ClaimsController } from './claims.controller';
import { ClaimsWorker } from './claims.worker';
import { PolicyStateCacheService } from './policy-state-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { JwtService } from '../auth/jwt.service';

import { Global, Module } from '@nestjs/common';

@Global()
@Module({
  providers: [{ provide: 'REDIS_CLIENT', useValue: {} }],
  exports: ['REDIS_CLIENT'],
})
class StubRedisModule {}

describe('ClaimsModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      // AuthModule (imported transitively) needs a real, resolvable
      // ConfigService for OperatorAuthGuard — ignoreEnvFile keeps this
      // hermetic since nothing here actually calls config.get() eagerly.
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), StubRedisModule, ClaimsModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(StellarService)
      .useValue({})
      .overrideProvider(JwtService)
      .useValue({})
      .overrideProvider('REDIS_CLIENT')
      .useValue({})
      .compile();
  });

  it('compiles with its declared imports (PrismaModule, OracleModule, PolicyModule, AuthModule, WebhooksModule)', () => {
    expect(module).toBeDefined();
  });

  it('provides and exports ClaimsService', () => {
    expect(module.get(ClaimsService)).toBeInstanceOf(ClaimsService);
  });

  it('wires up ClaimsController', () => {
    expect(module.get(ClaimsController)).toBeInstanceOf(ClaimsController);
  });

  it('provides ClaimsWorker', () => {
    expect(module.get(ClaimsWorker)).toBeInstanceOf(ClaimsWorker);
  });

  it('provides and exports PolicyStateCacheService', () => {
    expect(module.get(PolicyStateCacheService)).toBeInstanceOf(PolicyStateCacheService);
  });
});
