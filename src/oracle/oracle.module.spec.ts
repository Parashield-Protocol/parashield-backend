import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { OracleModule } from './oracle.module';
import { OracleService } from './oracle.service';
import { OracleController } from './oracle.controller';
import { OracleWorker } from './oracle.worker';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { JwtService } from '../auth/jwt.service';

describe('OracleModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), OracleModule],
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

  it('provides and exports OracleService', () => {
    expect(module.get(OracleService)).toBeInstanceOf(OracleService);
  });

  it('wires up OracleController', () => {
    expect(module.get(OracleController)).toBeInstanceOf(OracleController);
  });

  it('provides OracleWorker', () => {
    expect(module.get(OracleWorker)).toBeInstanceOf(OracleWorker);
  });
});
