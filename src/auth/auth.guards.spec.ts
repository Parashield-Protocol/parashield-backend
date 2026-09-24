import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OperatorAuthGuard } from './operator-auth.guard';
import { JwtService } from './jwt.service';
import { AuthenticatedRequest } from './authenticated-request';

describe('Auth guards', () => {
  const secret = 'test-secret';
  let jwtService: JwtService;
  let redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

  beforeEach(() => {
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };
    jwtService = new JwtService({
      get: jest.fn((key: string) => key === 'JWT_SECRET' ? secret : undefined),
    } as unknown as ConfigService);
  });

  function contextFor(request: Partial<AuthenticatedRequest>): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  }

  it('verifies bearer JWTs and sets req.wallet', () => {
    const token = jwtService.sign('GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ');
    const request = {
      headers: { authorization: `Bearer ${token}` },
    } as Partial<AuthenticatedRequest>;

    const guard = new JwtAuthGuard(jwtService);

    expect(guard.canActivate(contextFor(request))).toBe(true);
    expect(request.wallet).toBe('GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ');
  });

  it('sets req.user.walletAddress after successful JWT verification', () => {
    const walletAddress = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
    const token = jwtService.sign(walletAddress);
    const request = {
      headers: { authorization: `Bearer ${token}` },
    } as Partial<AuthenticatedRequest>;

    const guard = new JwtAuthGuard(jwtService);
    guard.canActivate(contextFor(request));

    expect(request.user?.walletAddress).toBe(walletAddress);
  });

  it('populates req.user with full JWT payload including role and admin', () => {
    const walletAddress = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
    const token = jwtService.signWithRole(walletAddress, 'admin', true);
    const request = {
      headers: { authorization: `Bearer ${token}` },
    } as Partial<AuthenticatedRequest>;

    const guard = new JwtAuthGuard(jwtService);
    guard.canActivate(contextFor(request));

    expect(request.user?.walletAddress).toBe(walletAddress);
    expect(request.user?.role).toBe('admin');
    expect(request.user?.admin).toBe(true);
  });

  it('rejects requests without JWTs on JWT-protected routes', () => {
    const guard = new JwtAuthGuard(jwtService);

    expect(() => guard.canActivate(contextFor({ headers: {} }))).toThrow(UnauthorizedException);
  });

  it('rejects expired JWTs', () => {
    const expiredToken = jwt.sign(
      { walletAddress: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ' },
      secret,
      { expiresIn: '-1s' },
    );
    const request = {
      headers: { authorization: `Bearer ${expiredToken}` },
    } as Partial<AuthenticatedRequest>;

    const guard = new JwtAuthGuard(jwtService);

    expect(() => guard.canActivate(contextFor(request))).toThrow(UnauthorizedException);
  });

  it('rejects JWTs signed with the wrong secret', () => {
    const wrongToken = jwt.sign(
      { walletAddress: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ' },
      'wrong-secret',
    );
    const request = {
      headers: { authorization: `Bearer ${wrongToken}` },
    } as Partial<AuthenticatedRequest>;

    const guard = new JwtAuthGuard(jwtService);

    expect(() => guard.canActivate(contextFor(request))).toThrow(UnauthorizedException);
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
  });

  it('allows admin JWTs for oracle fetch routes', async () => {
    const token = jwt.sign(
      { walletAddress: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ', role: 'admin' },
      secret,
      { expiresIn: '7d' },
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
});
