import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health.module';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';
import { StellarModule } from '../stellar/stellar.module';
import { StellarService } from '../stellar/stellar.service';

describe('HealthModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        StellarModule,
        HealthModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(StellarService)
      .useValue({
        keeperKeypair: { publicKey: () => 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ' },
        getAccountBalance: jest.fn().mockResolvedValue('100.0000000'),
      })
      .compile();
  });

  it('compiles successfully', () => {
    expect(module).toBeDefined();
  });

  it('wires up HealthController', () => {
    expect(module.get(HealthController)).toBeInstanceOf(HealthController);
  });
});
