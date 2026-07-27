import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma/prisma.service';
import { StellarService } from './stellar/stellar.service';

describe('AppModule', () => {
  let module: TestingModule;
  const originalEnv = process.env;

  beforeAll(async () => {
    process.env = {
      ...originalEnv,
      JWT_SECRET: 'test-secret',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
      STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
      KEEPER_SECRET_KEY: 'SCZANGBA5YHTNYVVV6C3TT4GZ7W7BYWY6SY6ZLJRJAGZLSFYAG4CZ7DQ',
    };
    const { AppModule } = await import('./app.module');
    module = await Test.createTestingModule({
      imports: [AppModule],
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

  afterAll(() => {
    process.env = originalEnv;
  });

  it('compiles successfully with all feature modules wired', () => {
    expect(module).toBeDefined();
  });
});
