import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from './jwt.service';
import { UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

describe('JwtService', () => {
  const redisStub = () => ({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(0),
  });

  const mockConfigService = (secret?: string) => ({
    get: jest.fn((key: string) => {
      if (key === 'JWT_SECRET') return secret;
      return undefined;
    }),
  });

  const VALID_SECRET = 'valid-test-jwt-secret-at-least-32-characters-long!';

  it('should throw an Error on initialization if JWT_SECRET is not set', async () => {
    expect(() => {
      new JwtService(mockConfigService(undefined) as any, redisStub() as any);
    }).toThrow('JWT_SECRET environment variable is required');
  });

  it('should throw an Error if JWT_SECRET is shorter than 32 characters', () => {
    expect(() => {
      new JwtService(mockConfigService('too-short-key') as any, redisStub() as any);
    }).toThrow(/at least 32 characters long/);
  });

  it('should throw an Error if JWT_SECRET uses the old default dev value', () => {
    expect(() => {
      new JwtService(
        mockConfigService('parashield-dev-secret-change-in-production') as any,
        redisStub() as any,
      );
    }).toThrow(/weak or placeholder values/);
  });

  it('should throw an Error if JWT_SECRET uses weak placeholder values', () => {
    expect(() => {
      new JwtService(mockConfigService('changeme') as any, redisStub() as any);
    }).toThrow();
    expect(() => {
      new JwtService(mockConfigService('secret') as any, redisStub() as any);
    }).toThrow();
  });

  it('should initialize successfully if valid JWT_SECRET is set', () => {
    const service = new JwtService(mockConfigService(VALID_SECRET) as any, redisStub() as any);
    expect(service).toBeDefined();
  });

  describe('sign and verify', () => {
    let service: JwtService;

    beforeEach(() => {
      service = new JwtService(mockConfigService(VALID_SECRET) as any, redisStub() as any);
    });

    it('should sign a token and verify it successfully', () => {
      const walletAddress = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
      const token = service.sign(walletAddress);
      expect(token).toBeDefined();

      const decoded = service.verify(token);
      expect(decoded.walletAddress).toBe(walletAddress);
    });

    it('should expose the configured token expiry', () => {
      expect(service.expiresIn).toBe('1h');
    });

    it('should throw UnauthorizedException for an invalid token', () => {
      expect(() => {
        service.verify('invalid.token.value');
      }).toThrow(UnauthorizedException);
    });

    // #555 — tokens with wrong issuer or audience must be rejected.
    // Each case keeps every other claim valid so the rejection is attributable
    // to the claim under test (a token missing `aud` would otherwise mask a
    // broken issuer check, and vice versa).
    describe('iss / aud claim validation', () => {
      const walletAddress = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
      const ISSUER = 'parashield-api';
      const AUDIENCE = 'parashield-clients';

      const mint = (claims: { iss?: string; aud?: string; type?: string; family?: string; jti?: string }) =>
        jwt.sign({ walletAddress, type: 'access', ...claims }, VALID_SECRET, {
          algorithm: 'HS256',
          expiresIn: '1h',
        });

      it('embeds iss and aud in every issued token', () => {
        for (const token of [
          service.sign(walletAddress),
          service.signWithRole(walletAddress, 'operator'),
          service.signRefresh(walletAddress),
        ]) {
          const decoded = jwt.decode(token) as jwt.JwtPayload;
          expect(decoded.iss).toBe(ISSUER);
          expect(decoded.aud).toBe(AUDIENCE);
        }
      });

      it('accepts a token with the correct iss and aud', () => {
        const token = mint({ iss: ISSUER, aud: AUDIENCE });
        expect(service.verify(token).walletAddress).toBe(walletAddress);
      });

      it('rejects a token with the correct aud but a different issuer', () => {
        const token = mint({ iss: 'other-service', aud: AUDIENCE });
        expect(() => service.verify(token)).toThrow(UnauthorizedException);
        expect(() => service.verify(token)).toThrow('Invalid token');
      });

      it('rejects a token with the correct iss but a different audience', () => {
        const token = mint({ iss: ISSUER, aud: 'other-service-clients' });
        expect(() => service.verify(token)).toThrow(UnauthorizedException);
        expect(() => service.verify(token)).toThrow('Invalid token');
      });

      it('rejects a token missing the iss claim', () => {
        const token = mint({ aud: AUDIENCE });
        expect(() => service.verify(token)).toThrow(UnauthorizedException);
      });

      it('rejects a token missing the aud claim', () => {
        const token = mint({ iss: ISSUER });
        expect(() => service.verify(token)).toThrow(UnauthorizedException);
      });

      it('rejects a token missing both iss and aud', () => {
        const token = mint({});
        expect(() => service.verify(token)).toThrow(UnauthorizedException);
      });

      it('verifyAsync rejects a token with a wrong audience', async () => {
        const token = mint({ iss: ISSUER, aud: 'other-service-clients' });
        await expect(service.verifyAsync(token)).rejects.toThrow(UnauthorizedException);
      });

      it('rotateRefresh rejects a refresh token with a wrong issuer or audience', async () => {
        const base = { type: 'refresh', family: 'fam-1', jti: 'jti-1' };
        await expect(
          service.rotateRefresh(mint({ ...base, iss: 'other-service', aud: AUDIENCE })),
        ).rejects.toThrow('Invalid refresh token');
        await expect(
          service.rotateRefresh(mint({ ...base, iss: ISSUER, aud: 'other-service-clients' })),
        ).rejects.toThrow('Invalid refresh token');
        await expect(service.rotateRefresh(mint({ ...base }))).rejects.toThrow('Invalid refresh token');
      });

      it('honours JWT_ISSUER / JWT_AUDIENCE and rejects tokens minted for the defaults', () => {
        const config = {
          get: jest.fn((key: string) => {
            if (key === 'JWT_SECRET') return VALID_SECRET;
            if (key === 'JWT_ISSUER') return 'parashield-api-staging';
            if (key === 'JWT_AUDIENCE') return 'parashield-staging-clients';
            return undefined;
          }),
        };
        const custom = new JwtService(config as any, redisStub() as any);

        const token = custom.sign(walletAddress);
        const decoded = jwt.decode(token) as jwt.JwtPayload;
        expect(decoded.iss).toBe('parashield-api-staging');
        expect(decoded.aud).toBe('parashield-staging-clients');
        expect(custom.verify(token).walletAddress).toBe(walletAddress);

        // Same secret, different service identity: tokens must not cross over.
        expect(() => custom.verify(service.sign(walletAddress))).toThrow(UnauthorizedException);
        expect(() => service.verify(token)).toThrow(UnauthorizedException);
      });
    });

    // #182 — the whole point of a 7-day expiry is that expired tokens are
    // rejected; craft an already-expired token directly with the same
    // secret the service uses, rather than only testing malformed strings.
    it('should throw UnauthorizedException for a legitimately expired token', () => {
      const walletAddress = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
      const expiredToken = jwt.sign({ walletAddress }, VALID_SECRET, { expiresIn: -10 });

      expect(() => service.verify(expiredToken)).toThrow(UnauthorizedException);
      expect(() => service.verify(expiredToken)).toThrow(/expired/i);
    });

    // #280 — Explicitly test the TokenExpiredError branch. Use the string
    // format (`'-1s'`) to mirror real-world token expiry, and assert the
    // exact error message so a regression that swaps the generic
    // "Invalid token" message for the expired path is caught.
    it('should surface "Token has expired" (not generic "Invalid token") for an expired token', () => {
      const walletAddress = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
      const expiredToken = jwt.sign({ walletAddress }, VALID_SECRET, { expiresIn: '-1s' });

      // Must be the *expired* message, not the generic JsonWebTokenError one
      expect(() => service.verify(expiredToken)).toThrow('Token has expired');
      expect(() => service.verify(expiredToken)).toThrow(UnauthorizedException);

      // Sanity: a malformed string yields a *different* message
      try {
        service.verify('garbage.token.here');
        fail('should have thrown');
      } catch (err) {
        expect((err as Error).message).toBe('Invalid token');
      }
    });

    // #182 — a validly-issued token that's been bit-flipped in transit (or
    // deliberately tampered with) must fail signature verification, not be
    // silently accepted with a corrupted payload.
    it('should throw UnauthorizedException for a tampered (bit-flipped) token', () => {
      const walletAddress = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
      const token = service.sign(walletAddress);

      // Flip one character in the signature segment (the part after the last '.').
      const parts = token.split('.');
      const signature = parts[2];
      const flippedChar = signature[0] === 'A' ? 'B' : 'A';
      parts[2] = flippedChar + signature.slice(1);
      const tamperedToken = parts.join('.');

      expect(() => service.verify(tamperedToken)).toThrow(UnauthorizedException);
    });

    it('signWithRole sets role and admin in the token payload', () => {
      const walletAddress = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';

      // Default admin=false
      const token = service.signWithRole(walletAddress, 'operator');
      const decoded = service.verify(token);
      expect(decoded.walletAddress).toBe(walletAddress);
      expect(decoded.role).toBe('operator');
      expect(decoded.admin).toBe(false);

      // Explicit admin=true
      const adminToken = service.signWithRole(walletAddress, 'admin', true);
      const adminDecoded = service.verify(adminToken);
      expect(adminDecoded.walletAddress).toBe(walletAddress);
      expect(adminDecoded.role).toBe('admin');
      expect(adminDecoded.admin).toBe(true);
    });

    // #244 — jwt.verify had no algorithms option, so it trusted the `alg`
    // header in the incoming token. Pinning algorithms: ['HS256'] prevents
    // algorithm-confusion attacks. These tests assert that tokens with any
    // other algorithm header are rejected regardless of their signature.
    describe('#244 — algorithm allow-list enforcement', () => {
      const walletAddress = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';

      it('rejects a token with alg:none (unsigned token attack)', () => {
        // Craft a token with algorithm "none" — no signature required by the spec
        // but must be treated as invalid when the verifier pins HS256.
        const header  = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ walletAddress, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
        const noneToken = `${header}.${payload}.`;

        expect(() => service.verify(noneToken)).toThrow(UnauthorizedException);
      });

      it('rejects a token signed with HS384 (algorithm outside the allow-list)', () => {
        // Signed with the same secret but a different algorithm — should fail
        // because HS384 is not in the ['HS256'] allow-list.
        const hs384Token = jwt.sign({ walletAddress }, VALID_SECRET, {
          algorithm: 'HS384',
          expiresIn: '7d',
        } as any);

        expect(() => service.verify(hs384Token)).toThrow(UnauthorizedException);
      });

      it('accepts a legitimately issued HS256 token', () => {
        const token = service.sign(walletAddress);
        // Confirm the issued token header declares HS256
        const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
        expect(header.alg).toBe('HS256');
        // And that verify accepts it
        const decoded = service.verify(token);
        expect(decoded.walletAddress).toBe(walletAddress);
      });

      it('sign and signWithRole both embed alg:HS256 in the token header', () => {
        const token     = service.sign(walletAddress);
        const roleToken = service.signWithRole(walletAddress, 'operator');

        const decodeHeader = (t: string) =>
          JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8'));

        expect(decodeHeader(token).alg).toBe('HS256');
        expect(decodeHeader(roleToken).alg).toBe('HS256');
      });
    });
  });
});
