import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from './jwt.service';
import { UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

describe('JwtService', () => {
  const mockConfigService = (secret?: string) => ({
    get: jest.fn((key: string) => {
      if (key === 'JWT_SECRET') return secret;
      return undefined;
    }),
  });

  it('should throw an Error on initialization if JWT_SECRET is not set', async () => {
    expect(() => {
      new JwtService(mockConfigService(undefined) as any);
    }).toThrow('JWT_SECRET environment variable is required');
  });

  it('should initialize successfully if JWT_SECRET is set', () => {
    const service = new JwtService(mockConfigService('my-secret-key') as any);
    expect(service).toBeDefined();
  });

  describe('sign and verify', () => {
    let service: JwtService;

    beforeEach(() => {
      service = new JwtService(mockConfigService('my-secret-key') as any);
    });

    it('should sign a token and verify it successfully', () => {
      const walletAddress = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
      const token = service.sign(walletAddress);
      expect(token).toBeDefined();

      const decoded = service.verify(token);
      expect(decoded.walletAddress).toBe(walletAddress);
    });

    it('should expose the configured token expiry', () => {
      expect(service.expiresIn).toBe('7d');
    });

    it('should throw UnauthorizedException for an invalid token', () => {
      expect(() => {
        service.verify('invalid.token.value');
      }).toThrow(UnauthorizedException);
    });

    // #182 — the whole point of a 7-day expiry is that expired tokens are
    // rejected; craft an already-expired token directly with the same
    // secret the service uses, rather than only testing malformed strings.
    it('should throw UnauthorizedException for a legitimately expired token', () => {
      const walletAddress = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
      const expiredToken = jwt.sign({ walletAddress }, 'my-secret-key', { expiresIn: -10 });

      expect(() => service.verify(expiredToken)).toThrow(UnauthorizedException);
      expect(() => service.verify(expiredToken)).toThrow(/expired/i);
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
        const hs384Token = jwt.sign({ walletAddress }, 'my-secret-key', {
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
