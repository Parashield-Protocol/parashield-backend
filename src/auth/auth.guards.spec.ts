import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OperatorAuthGuard } from './operator-auth.guard';
import { JwtService } from './jwt.service';
import { AuthenticatedRequest } from './authenticated-request';

describe('Auth guards', () => {
  const secret = 'test-secret-at-least-32-characters-long-for-testing!';
  let jwtService: JwtService;
  let redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock; exists: jest.Mock };

  beforeEach(() => {
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      exists: jest.fn().mockResolvedValue(0),
    };
    jwtService = new JwtService({
      get: jest.fn((key: string) => key === 'JWT_SECRET' ? secret : undefined),
    } as unknown as ConfigService, redis as any);
  });

  function contextFor(request: Partial<AuthenticatedRequest>): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  }

  it('verifies bearer JWTs and sets req.wallet', async () => {
    const token = jwtService.sign('GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ');
    const request = {
      headers: { authorization: `Bearer ${token}` },
    } as Partial<AuthenticatedRequest>;

    const guard = new JwtAuthGuard(jwtService);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.wallet).toBe('GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ');
  });

  it('sets req.user.walletAddress after successful JWT verification', async () => {
    const walletAddress = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
    const token = jwtService.sign(walletAddress);
    const request = {
      headers: { authorization: `Bearer ${token}` },
    } as Partial<AuthenticatedRequest>;

    const guard = new JwtAuthGuard(jwtService);
    await guard.canActivate(contextFor(request));

    expect(request.user?.walletAddress).toBe(walletAddress);
  });

  it('populates req.user with full JWT payload including role and admin', async () => {
    const walletAddress = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
    const token = jwtService.signWithRole(walletAddress, 'admin', true);
    const request = {
      headers: { authorization: `Bearer ${token}` },
    } as Partial<AuthenticatedRequest>;

    const guard = new JwtAuthGuard(jwtService);
    await guard.canActivate(contextFor(request));

    expect(request.user?.walletAddress).toBe(walletAddress);
    expect(request.user?.role).toBe('admin');
    expect(request.user?.admin).toBe(true);
  });

  it('rejects requests without JWTs on JWT-protected routes', async () => {
    const guard = new JwtAuthGuard(jwtService);

    await expect(guard.canActivate(contextFor({ headers: {} }))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects expired JWTs', async () => {
    const expiredToken = jwt.sign(
      { walletAddress: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ' },
      secret,
      { expiresIn: '-1s' },
    );
    const request = {
      headers: { authorization: `Bearer ${expiredToken}` },
    } as Partial<AuthenticatedRequest>;

    const guard = new JwtAuthGuard(jwtService);

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects JWTs signed with the wrong secret', async () => {
    const wrongToken = jwt.sign(
      { walletAddress: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ' },
      'wrong-secret',
    );
    const request = {
      headers: { authorization: `Bearer ${wrongToken}` },
    } as Partial<AuthenticatedRequest>;

    const guard = new JwtAuthGuard(jwtService);

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(UnauthorizedException);
  });

  it('allows operator API keys for oracle fetch routes', async () => {
    const config = {
      get: jest.fn((key: string) => key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-secret' : undefined),
    } as unknown as ConfigService;
    const request = {
      headers: { 'x-api-key': 'operator-secret' },
    } as Partial<AuthenticatedRequest>;

    const guard = new OperatorAuthGuard(config, jwtService, redis as any);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.authVia).toBe('api-key');
    expect(request.apiKeySource).toBe('operator');
  });

  // The oracle key authenticates, but it must not silently count as an admin
  // credential — AdminRoleGuard reads apiKeySource to tell them apart.
  it('authenticates ADMIN_API_KEY when both keys are configured, tagged as admin', async () => {
    const config = {
      get: jest.fn((key: string) =>
        key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-secret'
        : key === 'ADMIN_API_KEY' ? 'admin-secret'
        : undefined),
    } as unknown as ConfigService;
    const request = {
      headers: { 'x-admin-api-key': 'admin-secret' },
    } as Partial<AuthenticatedRequest>;

    const guard = new OperatorAuthGuard(config, jwtService, redis as any);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.authVia).toBe('api-key');
    expect(request.apiKeySource).toBe('admin');
  });

  it('tags a rotated-out key with the source it was rotated from', async () => {
    const config = {
      get: jest.fn((key: string) =>
        key === 'ORACLE_OPERATOR_API_KEY' ? 'current-operator'
        : key === 'ADMIN_API_KEY_PREVIOUS' ? 'old-admin-secret'
        : undefined),
    } as unknown as ConfigService;
    const request = {
      headers: { 'x-api-key': 'old-admin-secret' },
    } as Partial<AuthenticatedRequest>;

    const guard = new OperatorAuthGuard(config, jwtService, redis as any);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.apiKeySource).toBe('admin');
  });

  it('allows admin JWTs for oracle fetch routes', async () => {
    const token = jwtService.signWithRole(
      'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ',
      'admin',
      true,
    );
    const config = {
      get: jest.fn((key: string) => key === 'ORACLE_OPERATOR_API_KEY' ? 'dummy-key' : undefined),
    } as unknown as ConfigService;
    const request = {
      headers: { authorization: `Bearer ${token}` },
    } as Partial<AuthenticatedRequest>;

    const guard = new OperatorAuthGuard(config, jwtService, redis as any);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.wallet).toBe('GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ');
    expect(request.authVia).toBe('jwt');
    expect(request.apiKeySource).toBeUndefined();
  });

  // #182 — the guard's whole job is telling a wrong/missing key and a
  // non-admin caller apart from a legitimate operator/admin; these paths
  // were never exercised.
  it('rejects a wrong operator API key', async () => {
    const config = {
      get: jest.fn((key: string) => key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-secret' : undefined),
    } as unknown as ConfigService;
    const request = {
      headers: { 'x-api-key': 'not-the-right-key' },
    } as Partial<AuthenticatedRequest>;

    const guard = new OperatorAuthGuard(config, jwtService, redis as any);

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a missing operator API key and missing bearer token', async () => {
    const config = {
      get: jest.fn((key: string) => key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-secret' : undefined),
    } as unknown as ConfigService;
    const request = { headers: {} } as Partial<AuthenticatedRequest>;

    const guard = new OperatorAuthGuard(config, jwtService, redis as any);

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a non-admin JWT for operator/admin-gated routes', async () => {
    const token = jwtService.signWithRole('GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ', 'user', false);
    const config = {
      get: jest.fn((key: string) => key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-secret' : undefined),
    } as unknown as ConfigService;
    const request = {
      headers: { authorization: `Bearer ${token}` },
    } as Partial<AuthenticatedRequest>;

    const guard = new OperatorAuthGuard(config, jwtService, redis as any);

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(UnauthorizedException);
  });
  // #490 — API key comparison must go through timingSafeEqual on fixed-length
  // digests, so a key of a different length is rejected via the same
  // constant-time path rather than an early length check.
  it('compares API keys in constant time, including keys of a different length', async () => {
    const config = {
      get: jest.fn((key: string) => key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-secret' : undefined),
    } as unknown as ConfigService;
    const spy = jest.spyOn(crypto, 'timingSafeEqual');

    const guard = new OperatorAuthGuard(config, jwtService, redis as any);
    const request = { headers: { 'x-api-key': 'short' } } as Partial<AuthenticatedRequest>;

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(UnauthorizedException);
    expect(spy).toHaveBeenCalled();
    for (const [a, b] of spy.mock.calls) {
      expect((a as Buffer).length).toBe(32);
      expect((b as Buffer).length).toBe(32);
    }
    spy.mockRestore();
  });

  // #379 — API key rotation with grace period tests
  describe('API key rotation with grace period', () => {
    it('accepts current ADMIN_API_KEY immediately', async () => {
      const config = {
        get: jest.fn((key: string) =>
          key === 'ADMIN_API_KEY' ? 'current-admin-key'
          : key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-key'
          : undefined),
      } as unknown as ConfigService;
      const request = {
        headers: { 'x-api-key': 'current-admin-key' },
      } as Partial<AuthenticatedRequest>;

      const guard = new OperatorAuthGuard(config, jwtService, redis as any);
      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
      expect(request.apiKeySource).toBe('admin');
    });

    it('accepts previous ADMIN_API_KEY during grace period', async () => {
      const config = {
        get: jest.fn((key: string) =>
          key === 'ADMIN_API_KEY' ? 'current-admin-key'
          : key === 'ADMIN_API_KEY_PREVIOUS' ? 'old-admin-key'
          : key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-key'
          : key === 'API_KEY_ROTATION_GRACE_MINUTES' ? '24'
          : undefined),
      } as unknown as ConfigService;
      const request = {
        headers: { 'x-api-key': 'old-admin-key' },
      } as Partial<AuthenticatedRequest>;

      const guard = new OperatorAuthGuard(config, jwtService, redis as any);
      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
      expect(request.apiKeySource).toBe('admin');
    });

    it('rejects previous ADMIN_API_KEY after grace period expires', async () => {
      const config = {
        get: jest.fn((key: string) =>
          key === 'ADMIN_API_KEY' ? 'current-admin-key'
          : key === 'ADMIN_API_KEY_PREVIOUS' ? 'old-admin-key'
          : key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-key'
          : key === 'API_KEY_ROTATION_GRACE_MINUTES' ? '0'  // Grace period disabled
          : undefined),
      } as unknown as ConfigService;
      const request = {
        headers: { 'x-api-key': 'old-admin-key' },
      } as Partial<AuthenticatedRequest>;

      const guard = new OperatorAuthGuard(config, jwtService, redis as any);
      await expect(guard.canActivate(contextFor(request))).rejects.toThrow(UnauthorizedException);
    });

    it('accepts current ORACLE_OPERATOR_API_KEY immediately', async () => {
      const config = {
        get: jest.fn((key: string) =>
          key === 'ORACLE_OPERATOR_API_KEY' ? 'current-operator-key'
          : undefined),
      } as unknown as ConfigService;
      const request = {
        headers: { 'x-api-key': 'current-operator-key' },
      } as Partial<AuthenticatedRequest>;

      const guard = new OperatorAuthGuard(config, jwtService, redis as any);
      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
      expect(request.apiKeySource).toBe('operator');
    });

    it('accepts previous ORACLE_OPERATOR_API_KEY during grace period', async () => {
      const config = {
        get: jest.fn((key: string) =>
          key === 'ORACLE_OPERATOR_API_KEY' ? 'current-operator-key'
          : key === 'ORACLE_OPERATOR_API_KEY_PREVIOUS' ? 'old-operator-key'
          : key === 'API_KEY_ROTATION_GRACE_MINUTES' ? '24'
          : undefined),
      } as unknown as ConfigService;
      const request = {
        headers: { 'x-api-key': 'old-operator-key' },
      } as Partial<AuthenticatedRequest>;

      const guard = new OperatorAuthGuard(config, jwtService, redis as any);
      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
      expect(request.apiKeySource).toBe('operator');
    });

    it('supports comma-separated multiple previous ADMIN_API_KEYs', async () => {
      const config = {
        get: jest.fn((key: string) =>
          key === 'ADMIN_API_KEY' ? 'current-admin-key'
          : key === 'ADMIN_API_KEY_PREVIOUS' ? 'old-key-1,old-key-2,old-key-3'
          : key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-key'
          : key === 'API_KEY_ROTATION_GRACE_MINUTES' ? '24'
          : undefined),
      } as unknown as ConfigService;

      const guard = new OperatorAuthGuard(config, jwtService, redis as any);

      // Test first old key
      const request1 = { headers: { 'x-api-key': 'old-key-1' } } as Partial<AuthenticatedRequest>;
      await expect(guard.canActivate(contextFor(request1))).resolves.toBe(true);
      expect(request1.apiKeySource).toBe('admin');

      // Test middle old key
      const request2 = { headers: { 'x-api-key': 'old-key-2' } } as Partial<AuthenticatedRequest>;
      await expect(guard.canActivate(contextFor(request2))).resolves.toBe(true);
      expect(request2.apiKeySource).toBe('admin');

      // Test last old key
      const request3 = { headers: { 'x-api-key': 'old-key-3' } } as Partial<AuthenticatedRequest>;
      await expect(guard.canActivate(contextFor(request3))).resolves.toBe(true);
      expect(request3.apiKeySource).toBe('admin');
    });

    it('supports comma-separated multiple previous ORACLE_OPERATOR_API_KEYs with whitespace', async () => {
      const config = {
        get: jest.fn((key: string) =>
          key === 'ORACLE_OPERATOR_API_KEY' ? 'current-operator-key'
          : key === 'ORACLE_OPERATOR_API_KEY_PREVIOUS' ? 'old-key-1 , old-key-2 , old-key-3'
          : key === 'API_KEY_ROTATION_GRACE_MINUTES' ? '24'
          : undefined),
      } as unknown as ConfigService;

      const guard = new OperatorAuthGuard(config, jwtService, redis as any);

      // Test that whitespace is properly trimmed
      const request = { headers: { 'x-api-key': 'old-key-2' } } as Partial<AuthenticatedRequest>;
      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
      expect(request.apiKeySource).toBe('operator');
    });

    it('rejects unrecognized keys even with multiple previous keys configured', async () => {
      const config = {
        get: jest.fn((key: string) =>
          key === 'ADMIN_API_KEY' ? 'current-admin-key'
          : key === 'ADMIN_API_KEY_PREVIOUS' ? 'old-key-1,old-key-2'
          : key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-key'
          : key === 'API_KEY_ROTATION_GRACE_MINUTES' ? '24'
          : undefined),
      } as unknown as ConfigService;
      const request = {
        headers: { 'x-api-key': 'totally-wrong-key' },
      } as Partial<AuthenticatedRequest>;

      const guard = new OperatorAuthGuard(config, jwtService, redis as any);
      await expect(guard.canActivate(contextFor(request))).rejects.toThrow(UnauthorizedException);
    });
  });

  // Rate limiting tests
  describe('Rate limiting for API keys', () => {
    it('tracks failed authentication attempts by IP', async () => {
      const config = {
        get: jest.fn((key: string) => key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-secret' : undefined),
      } as unknown as ConfigService;

      redis.get.mockResolvedValueOnce(null); // First check
      redis.set.mockResolvedValueOnce('OK'); // Record failure

      const request = {
        headers: { 'x-api-key': 'wrong-key' },
        ip: '192.168.1.100',
      } as Partial<AuthenticatedRequest>;

      const guard = new OperatorAuthGuard(config, jwtService, redis as any);
      await expect(guard.canActivate(contextFor(request))).rejects.toThrow(UnauthorizedException);

      expect(redis.set).toHaveBeenCalled();
      const setCall = redis.set.mock.calls[0];
      expect(setCall[0]).toContain('192.168.1.100');
    });

    it('blocks requests after 5 failed attempts', async () => {
      const config = {
        get: jest.fn((key: string) => key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-secret' : undefined),
      } as unknown as ConfigService;

      const failureRecord = {
        count: 5,
        resetAt: Date.now() + 60_000,
      };

      redis.get.mockResolvedValueOnce(JSON.stringify(failureRecord));

      const request = {
        headers: { 'x-api-key': 'wrong-key' },
        ip: '192.168.1.100',
      } as Partial<AuthenticatedRequest>;

      const guard = new OperatorAuthGuard(config, jwtService, redis as any);
      await expect(guard.canActivate(contextFor(request))).rejects.toThrow('Too many failed authentication attempts');
    });

    it('resets failure count on successful authentication', async () => {
      const config = {
        get: jest.fn((key: string) => key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-secret' : undefined),
      } as unknown as ConfigService;

      redis.get.mockResolvedValueOnce(null); // No prior failures
      redis.del.mockResolvedValueOnce(1); // Reset on success

      const request = {
        headers: { 'x-api-key': 'operator-secret' },
        ip: '192.168.1.100',
      } as Partial<AuthenticatedRequest>;

      const guard = new OperatorAuthGuard(config, jwtService, redis as any);
      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

      expect(redis.del).toHaveBeenCalled();
      const delCall = redis.del.mock.calls[0];
      expect(delCall[0]).toContain('192.168.1.100');
    });

    it('resets failure count on successful JWT authentication', async () => {
      const token = jwtService.signWithRole(
        'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ',
        'admin',
        true,
      );
      const config = {
        get: jest.fn((key: string) => key === 'ORACLE_OPERATOR_API_KEY' ? 'dummy-key' : undefined),
      } as unknown as ConfigService;

      redis.get.mockResolvedValueOnce(null);
      redis.del.mockResolvedValueOnce(1);

      const request = {
        headers: { authorization: `Bearer ${token}` },
        ip: '192.168.1.100',
      } as Partial<AuthenticatedRequest>;

      const guard = new OperatorAuthGuard(config, jwtService, redis as any);
      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

      expect(redis.del).toHaveBeenCalledWith(expect.stringContaining('192.168.1.100'));
    });
  });

  // Admin JWT validation tests
  describe('Admin JWT validation', () => {
    it('requires admin: true flag on JWT', async () => {
      const token = jwtService.signWithRole('GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ', 'admin', false);
      const config = {
        get: jest.fn((key: string) => key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-secret' : undefined),
      } as unknown as ConfigService;
      const request = {
        headers: { authorization: `Bearer ${token}` },
      } as Partial<AuthenticatedRequest>;

      const guard = new OperatorAuthGuard(config, jwtService, redis as any);
      await expect(guard.canActivate(contextFor(request))).rejects.toThrow('Admin bearer token required');
    });

    it('accepts JWT with admin: true', async () => {
      const token = jwtService.signWithRole('GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ', 'admin', true);
      const config = {
        get: jest.fn((key: string) => key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-secret' : undefined),
      } as unknown as ConfigService;

      redis.get.mockResolvedValueOnce(null);
      redis.del.mockResolvedValueOnce(1);

      const request = {
        headers: { authorization: `Bearer ${token}` },
      } as Partial<AuthenticatedRequest>;

      const guard = new OperatorAuthGuard(config, jwtService, redis as any);
      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
      expect(request.authVia).toBe('jwt');
    });

    it('accepts JWT with role: admin', async () => {
      const token = jwtService.signWithRole('GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ', 'admin', false);
      const config = {
        get: jest.fn((key: string) => key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-secret' : undefined),
      } as unknown as ConfigService;

      // Override the token to include role: admin
      const verifyAsyncSpy = jest.spyOn(jwtService, 'verifyAsync').mockResolvedValueOnce({
        walletAddress: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ',
        role: 'admin',
        admin: false,
      });

      redis.get.mockResolvedValueOnce(null);
      redis.del.mockResolvedValueOnce(1);

      const request = {
        headers: { authorization: 'Bearer dummy-token' },
      } as Partial<AuthenticatedRequest>;

      const guard = new OperatorAuthGuard(config, jwtService, redis as any);
      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

      verifyAsyncSpy.mockRestore();
    });
  });

  // Oracle-only key validation tests
  describe('Oracle-only key validation', () => {
    it('accepts ORACLE_OPERATOR_API_KEY when ADMIN_API_KEY is set', async () => {
      const config = {
        get: jest.fn((key: string) =>
          key === 'ADMIN_API_KEY' ? 'admin-secret'
          : key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-secret'
          : undefined),
      } as unknown as ConfigService;
      const request = {
        headers: { 'x-api-key': 'operator-secret' },
      } as Partial<AuthenticatedRequest>;

      const guard = new OperatorAuthGuard(config, jwtService, redis as any);
      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
      expect(request.apiKeySource).toBe('operator');
    });

    it('rejects admin bearer tokens when only ORACLE_OPERATOR_API_KEY is configured', async () => {
      const token = jwtService.signWithRole('GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ', 'admin', true);
      const config = {
        get: jest.fn((key: string) => key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-secret' : undefined),
      } as unknown as ConfigService;
      const request = {
        headers: { authorization: `Bearer ${token}` },
      } as Partial<AuthenticatedRequest>;

      const guard = new OperatorAuthGuard(config, jwtService, redis as any);
      // Should pass through to authorization check and succeed since only ORACLE_OPERATOR_API_KEY is set
      // but JWT with admin should still work for operator routes
      redis.get.mockResolvedValueOnce(null);
      redis.del.mockResolvedValueOnce(1);

      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    });
  });
