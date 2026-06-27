import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from './jwt.service';
import { UnauthorizedException } from '@nestjs/common';

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
  });
});
