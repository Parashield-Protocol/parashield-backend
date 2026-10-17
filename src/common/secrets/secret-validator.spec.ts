import { Logger } from '@nestjs/common';
import {
  evaluateSecretEntropy,
  validateStellarSecretKey,
  validateDatabaseUrl,
  validateRedisUrl,
  validateAllSecrets,
  calculateShannonEntropy,
  countDistinctCharacters,
  hasRepeatedPattern,
  isSimpleSequence,
} from './secret-validator';

describe('SecretValidator (#716)', () => {
  const STRONG_HEX_SECRET = 'a3f1c849e7b2d560184c9f3e7a0b5d2e4f6a8c1e3b5d7f9a2c4e6b8d0f1a3c5e';
  const STRONG_BASE64_SECRET = 'K7gNu3+zqL/1VpM8xQ2jFw9tY6rB0vE4hA5sC8dD1kI=';
  const STRONG_RANDOM_SECRET = '9xK#mP2$vL5*nQ8@wR1!zT4&yU7^aB0%cD3~eF6_';

  describe('Entropy and pattern helpers', () => {
    it('calculates Shannon entropy correctly', () => {
      expect(calculateShannonEntropy('')).toBe(0);
      expect(calculateShannonEntropy('aaaa')).toBe(0);
      // 'ab' has 1 bit of entropy per char
      expect(calculateShannonEntropy('abab')).toBeCloseTo(1.0, 5);
      // Random hex string has > 3 bits/char
      expect(calculateShannonEntropy(STRONG_HEX_SECRET)).toBeGreaterThan(3.5);
    });

    it('counts distinct characters', () => {
      expect(countDistinctCharacters('aaaaa')).toBe(1);
      expect(countDistinctCharacters('abcde')).toBe(5);
    });

    it('detects repeated character patterns', () => {
      expect(hasRepeatedPattern('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
      expect(hasRepeatedPattern('abababababababababababababababab')).toBe(true);
      expect(hasRepeatedPattern('abcabcabcabcabcabcabcabcabcabcabc')).toBe(true);
      expect(hasRepeatedPattern(STRONG_HEX_SECRET)).toBe(false);
    });

    it('detects simple sequential sequences', () => {
      expect(isSimpleSequence('abcdefghijklmnopqrstuvwxyz012345')).toBe(false); // breaks at z->0
      expect(isSimpleSequence('0123456789')).toBe(true);
      expect(isSimpleSequence('9876543210')).toBe(true);
      expect(isSimpleSequence('abcdefghijklmnop')).toBe(true);
      expect(isSimpleSequence(STRONG_HEX_SECRET)).toBe(false);
    });
  });

  describe('evaluateSecretEntropy', () => {
    it('rejects empty or whitespace-only values', () => {
      expect(evaluateSecretEntropy('').valid).toBe(false);
      expect(evaluateSecretEntropy('   ').valid).toBe(false);
      expect(evaluateSecretEntropy('\t\n').valid).toBe(false);
    });

    it('rejects secrets shorter than minimum length', () => {
      const res = evaluateSecretEntropy('too-short', 32);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('insufficient length');
    });

    it('rejects known placeholder and default values', () => {
      const placeholders = [
        'secret',
        'changeme',
        'change-me',
        'password',
        'test',
        'parashield-dev-secret',
        'parashield-dev-secret-change-in-production',
        'non-production-dev-jwt-secret-min-32-chars-long-do-not-use-in-production',
      ];
      for (const p of placeholders) {
        const padded = p.padEnd(35, 'x');
        const res = evaluateSecretEntropy(padded, 32);
        expect(res.valid).toBe(false);
        expect(res.reason).toContain('known placeholder');
      }
    });

    it('rejects single repeated character values', () => {
      const res = evaluateSecretEntropy('a'.repeat(32), 32);
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/character variety|repeating character/);
    });

    it('rejects low-variety / low-entropy values', () => {
      const lowVariety = 'abababababababababababababababab';
      const res = evaluateSecretEntropy(lowVariety, 32);
      expect(res.valid).toBe(false);
    });

    it('accepts strong random hex secrets', () => {
      const res = evaluateSecretEntropy(STRONG_HEX_SECRET, 32);
      expect(res.valid).toBe(true);
    });

    it('accepts strong random base64 secrets', () => {
      const res = evaluateSecretEntropy(STRONG_BASE64_SECRET, 32);
      expect(res.valid).toBe(true);
    });

    it('accepts strong alphanumeric and special-character secrets', () => {
      const res = evaluateSecretEntropy(STRONG_RANDOM_SECRET, 32);
      expect(res.valid).toBe(true);
    });
  });

  describe('validateStellarSecretKey', () => {
    it('rejects invalid or placeholder Stellar secret keys', () => {
      expect(validateStellarSecretKey('').valid).toBe(false);
      expect(validateStellarSecretKey('S...').valid).toBe(false);
      expect(validateStellarSecretKey('invalid-key').valid).toBe(false);
      expect(validateStellarSecretKey('G' + 'A'.repeat(55)).valid).toBe(false); // Public key, not secret
    });

    it('accepts a valid Stellar secret key format', () => {
      // S + 55 valid base32 chars
      // Test key generated from standard seed:
      // SB2W326SZWNZ22V2744H425PZ3C52LNJR653C72AOWZ7QW63U3V5EULR
      const validStellarSecret = 'SB2W326SZWNZ22V2744H425PZ3C52LNJR653C72AOWZ7QW63U3V5EULR';
      const res = validateStellarSecretKey(validStellarSecret);
      expect(res.valid).toBe(true);
    });
  });

  describe('validateDatabaseUrl', () => {
    it('rejects non-Postgres URLs', () => {
      expect(validateDatabaseUrl('mysql://localhost:3306/db').valid).toBe(false);
      expect(validateDatabaseUrl('').valid).toBe(false);
    });

    it('rejects database URLs with weak placeholder passwords', () => {
      const res = validateDatabaseUrl('postgresql://user:secret@localhost:5432/dbname');
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('placeholder password');
    });

    it('accepts valid database URLs with strong passwords', () => {
      const res = validateDatabaseUrl(`postgresql://user:${STRONG_HEX_SECRET}@localhost:5432/dbname`);
      expect(res.valid).toBe(true);
    });
  });

  describe('validateRedisUrl', () => {
    it('rejects non-Redis URLs', () => {
      expect(validateRedisUrl('http://localhost:6379').valid).toBe(false);
    });

    it('rejects Redis URLs with weak placeholder passwords', () => {
      const res = validateRedisUrl('redis://:redispass@localhost:6379');
      expect(res.valid).toBe(false);
    });

    it('accepts valid Redis URLs', () => {
      const res = validateRedisUrl('redis://localhost:6379');
      expect(res.valid).toBe(true);
    });
  });

  describe('validateAllSecrets (Production vs Non-Production)', () => {
    const validConfig: Record<string, unknown> = {
      NODE_ENV: 'production',
      JWT_SECRET: STRONG_HEX_SECRET,
      KEEPER_SECRET_KEY: 'SB2W326SZWNZ22V2744H425PZ3C52LNJR653C72AOWZ7QW63U3V5EULR',
      DATABASE_URL: `postgresql://user:${STRONG_HEX_SECRET}@localhost:5432/db`,
      ORACLE_OPERATOR_API_KEY: STRONG_BASE64_SECRET,
    };

    it('passes in production mode when all secrets are strong', () => {
      const report = validateAllSecrets(validConfig, 'production');
      expect(report.valid).toBe(true);
      expect(report.errors).toHaveLength(0);
    });

    it('rejects weak secrets in production mode with a clear Error', () => {
      const weakConfig = {
        ...validConfig,
        JWT_SECRET: 'changeme'.repeat(4),
      };

      expect(() => validateAllSecrets(weakConfig, 'production')).toThrow(
        /Production secret validation failed/,
      );
    });

    it('does not throw but logs warnings in non-production mode for weak secrets', () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const weakDevConfig = {
        ...validConfig,
        NODE_ENV: 'development',
        JWT_SECRET: 'non-production-dev-jwt-secret-min-32-chars-long-do-not-use-in-production',
        ORACLE_OPERATOR_API_KEY: 'non-production-dev-oracle-operator-key-min-32-chars-do-not-use',
      };

      const report = validateAllSecrets(weakDevConfig, 'development');
      expect(report.valid).toBe(true);
      expect(report.warnings.length).toBeGreaterThan(0);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('still throws for missing required secrets even in non-production mode', () => {
      const missingConfig = {
        ...validConfig,
        DATABASE_URL: '',
      };

      const report = validateAllSecrets(missingConfig, 'development');
      expect(report.valid).toBe(false);
      expect(report.errors.some((e) => e.name === 'DATABASE_URL')).toBe(true);
    });

    it('NEVER leaks secret values or fragments in thrown errors or warnings', () => {
      const sensitiveWeakSecret = 'SuperSecretLeakedPassword1234567890123!';
      const weakConfig = {
        ...validConfig,
        JWT_SECRET: sensitiveWeakSecret,
      };

      try {
        validateAllSecrets(weakConfig, 'production');
        fail('Expected validateAllSecrets to throw in production');
      } catch (err) {
        const message = (err as Error).message;
        // The error must mention the secret NAME (JWT_SECRET)
        expect(message).toContain('JWT_SECRET');
        // The error must NEVER mention the secret value or fragment
        expect(message).not.toContain(sensitiveWeakSecret);
        expect(message).not.toContain('SuperSecret');
        expect(message).not.toContain('LeakedPassword');
      }
    });

    it('NEVER leaks secret values in non-production warnings', () => {
      const sensitiveDevSecret = 'DevSecretFragmentToEnsureNoLeakage!';
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const weakDevConfig = {
        ...validConfig,
        JWT_SECRET: sensitiveDevSecret,
      };

      validateAllSecrets(weakDevConfig, 'development');

      for (const call of warnSpy.mock.calls) {
        const logMsg = String(call[0]);
        expect(logMsg).toContain('JWT_SECRET');
        expect(logMsg).not.toContain(sensitiveDevSecret);
        expect(logMsg).not.toContain('DevSecretFragment');
      }
      warnSpy.mockRestore();
    });
  });
});
