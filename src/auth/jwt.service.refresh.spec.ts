import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { JwtService } from './jwt.service';

// #843 — unit coverage for refresh token rotation and family invalidation.
// Redis is replaced with an in-memory fake that honours SET ... NX so the
// rotation path behaves as it does against a real server.

const VALID_SECRET = 'valid-test-jwt-secret-at-least-32-characters-long!';
const ISSUER = 'parashield-api';
const AUDIENCE = 'parashield-clients';
const WALLET = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';

const createFakeRedis = () => {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    exists: jest.fn(async (key: string) => (store.has(key) ? 1 : 0)),
  };
};

const mockConfigService = (secret: string) => ({
  get: jest.fn((key: string) => (key === 'JWT_SECRET' ? secret : undefined)),
});

const decodePayload = (token: string) => jwt.decode(token) as jwt.JwtPayload & { family?: string; type?: string; jti?: string };

describe('JwtService refresh token rotation (#843)', () => {
  let redis: ReturnType<typeof createFakeRedis>;
  let service: JwtService;

  beforeEach(() => {
    redis = createFakeRedis();
    service = new JwtService(mockConfigService(VALID_SECRET) as unknown as ConfigService, redis as any);
  });

  describe('signRefresh', () => {
    it('generates a new family when none is provided', () => {
      const first = decodePayload(service.signRefresh(WALLET));
      const second = decodePayload(service.signRefresh(WALLET));

      expect(first.family).toEqual(expect.any(String));
      expect(first.family).toMatch(/^[0-9a-f-]{36}$/);
      expect(second.family).toEqual(expect.any(String));
      expect(second.family).not.toBe(first.family);
    });

    it('reuses the supplied family when one is provided', () => {
      const payload = decodePayload(service.signRefresh(WALLET, 'family-given'));
      expect(payload.family).toBe('family-given');
      expect(payload.type).toBe('refresh');
      expect(payload.jti).toEqual(expect.any(String));
    });
  });

  describe('rotateRefresh', () => {
    it('issues a new refresh token in the same family', async () => {
      const original = service.signRefresh(WALLET, 'family-rotate');

      const { refreshToken, accessToken } = await service.rotateRefresh(original);

      const rotated = decodePayload(refreshToken);
      expect(rotated.type).toBe('refresh');
      expect(rotated.family).toBe('family-rotate');
      expect(rotated.jti).not.toBe(decodePayload(original).jti);
      expect(decodePayload(accessToken).type).toBe('access');
      expect(service.verify(accessToken).walletAddress).toBe(WALLET);
    });

    it('keeps the same family across consecutive rotations', async () => {
      let token = service.signRefresh(WALLET, 'family-chain');

      for (let i = 0; i < 3; i++) {
        const result = await service.rotateRefresh(token);
        expect(decodePayload(result.refreshToken).family).toBe('family-chain');
        token = result.refreshToken;
      }
    });

    it('invalidates the whole family when a rotated token is reused', async () => {
      const original = service.signRefresh(WALLET, 'family-reuse');
      const { refreshToken: successor } = await service.rotateRefresh(original);

      // Reusing the original (already rotated) token must fail...
      await expect(service.rotateRefresh(original)).rejects.toThrow(UnauthorizedException);
      await expect(service.rotateRefresh(original)).rejects.toThrow(
        'Refresh token reuse detected',
      );

      // The family is marked revoked in Redis.
      expect(await service.isFamilyRevoked('family-reuse')).toBe(true);
      expect(successor).toEqual(expect.any(String));
    });

    it('rejects an expired refresh token without touching Redis', async () => {
      const expired = jwt.sign(
        { walletAddress: WALLET, type: 'refresh', family: 'family-expired', jti: 'jti-expired' },
        VALID_SECRET,
        { algorithm: 'HS256', expiresIn: -10, issuer: ISSUER, audience: AUDIENCE },
      );

      await expect(service.rotateRefresh(expired)).rejects.toThrow(UnauthorizedException);
      await expect(service.rotateRefresh(expired)).rejects.toThrow('Invalid refresh token');
      expect(redis.set).not.toHaveBeenCalled();
      expect(await service.isFamilyRevoked('family-expired')).toBe(false);
    });

    it('rejects an access token presented as a refresh token', async () => {
      await expect(service.rotateRefresh(service.sign(WALLET))).rejects.toThrow(
        'Invalid refresh token',
      );
    });
  });

  describe('family revocation', () => {
    it('isFamilyRevoked is false for a family that was never invalidated', async () => {
      expect(await service.isFamilyRevoked('family-clean')).toBe(false);
    });

    it('isFamilyRevoked returns true after invalidateFamily', async () => {
      await service.invalidateFamily('family-manual');

      expect(await service.isFamilyRevoked('family-manual')).toBe(true);
      expect(redis.set).toHaveBeenCalledWith('jwt:family:revoked:family-manual', '1', 'EX', 7 * 24 * 3600);
    });

    it('does not revoke unrelated families', async () => {
      await service.invalidateFamily('family-a');

      expect(await service.isFamilyRevoked('family-b')).toBe(false);
    });
  });
});
