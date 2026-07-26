import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PolicyModule } from './policy.module';
import { PolicyService } from './policy.service';
import { PolicyController } from './policy.controller';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { JwtService } from '../auth/jwt.service';

describe('PolicyModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      // AuthModule (imported by PolicyModule) needs a real, resolvable
      // ConfigService for OperatorAuthGuard — ignoreEnvFile keeps this
      // hermetic since nothing here actually calls config.get() eagerly.
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PolicyModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(StellarService)
      .useValue({})
      .overrideProvider(JwtService)
      .useValue({})
      .compile();
  });

  it('compiles with its declared imports (PrismaModule, StellarModule, AuthModule)', () => {
    expect(module).toBeDefined();
  });

  it('provides and exports PolicyService', () => {
    expect(module.get(PolicyService)).toBeInstanceOf(PolicyService);
  });

  it('wires up PolicyController', () => {
    expect(module.get(PolicyController)).toBeInstanceOf(PolicyController);
  });
});
