import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OperatorAuthGuard } from './operator-auth.guard';
import { JwtService } from './jwt.service';
import { AuthenticatedRequest } from './authenticated-request';

describe('Auth guards', () => {
  const secret = 'test-secret';
  let jwtService: JwtService;

  beforeEach(() => {
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

  it('allows operator API keys for oracle fetch routes', () => {
    const config = {
      get: jest.fn((key: string) => key === 'ORACLE_OPERATOR_API_KEY' ? 'operator-secret' : undefined),
    } as unknown as ConfigService;
    const request = {
      headers: { 'x-api-key': 'operator-secret' },
    } as Partial<AuthenticatedRequest>;

    const guard = new OperatorAuthGuard(config, jwtService);

    expect(guard.canActivate(contextFor(request))).toBe(true);
  });

  it('allows admin JWTs for oracle fetch routes', () => {
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

    const guard = new OperatorAuthGuard(config, jwtService);

    expect(guard.canActivate(contextFor(request))).toBe(true);
    expect(request.wallet).toBe('GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ');
  });
});
