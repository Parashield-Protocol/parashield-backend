import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma/prisma.service';
import { StellarService } from './stellar/stellar.service';
import { validateJwtSecret } from './auth/jwt-secret.validator';

describe('AppModule', () => {
  let module: TestingModule;
  const originalEnv = process.env;
  const VALID_TEST_SECRET = 'valid-jwt-secret-min-32-chars-long-for-testing-only!';

  beforeAll(async () => {
    process.env = {
      ...originalEnv,
      JWT_SECRET: VALID_TEST_SECRET,
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
      STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
      KEEPER_SECRET_KEY: 'SCZANGBA5YHTNYVVV6C3TT4GZ7W7BYWY6SY6ZLJRJAGZLSFYAG4CZ7DQ',
      ORACLE_OPERATOR_API_KEY: 'operator-api-key-min-32-characters-long-test',
      CORS_ORIGIN: 'http://localhost:3000',
    };
    const { AppModule } = await import('./app.module');
    module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(StellarService)
      .useValue({
        keeperPublicKey: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ',
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

  describe('startup JWT_SECRET validation (Issue #674)', () => {
    it('fails startup if JWT_SECRET is missing', () => {
      const result = validateJwtSecret(undefined);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('JWT_SECRET environment variable is required');
    });

    it('fails startup if JWT_SECRET is too short (< 32 chars)', () => {
      const result = validateJwtSecret('too-short-secret');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('at least 32 characters long');
    });

    it('fails startup if the old default value is used', () => {
      const result = validateJwtSecret('parashield-dev-secret-change-in-production');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('weak or placeholder values');
    });

    it('fails startup if obviously weak or placeholder values are used', () => {
      expect(validateJwtSecret('changeme').valid).toBe(false);
      expect(validateJwtSecret('secret').valid).toBe(false);
      expect(validateJwtSecret('change-me-in-production').valid).toBe(false);
    });

    it('succeeds startup with a valid secret of sufficient length', () => {
      const result = validateJwtSecret(VALID_TEST_SECRET);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });
});
