import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ClaimsModule } from './claims.module';
import { ClaimsService } from './claims.service';
import { ClaimsController } from './claims.controller';
import { ClaimsWorker } from './claims.worker';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { JwtService } from '../auth/jwt.service';

describe('ClaimsModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      // AuthModule (imported transitively) needs a real, resolvable
      // ConfigService for OperatorAuthGuard — ignoreEnvFile keeps this
      // hermetic since nothing here actually calls config.get() eagerly.
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), ClaimsModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(StellarService)
      .useValue({})
      .overrideProvider(JwtService)
      .useValue({})
      .compile();
  });

  it('compiles with its declared imports (PrismaModule, OracleModule, PolicyModule, AuthModule)', () => {
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
});
