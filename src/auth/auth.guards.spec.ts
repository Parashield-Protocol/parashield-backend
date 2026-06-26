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

  it('rejects requests without JWTs on JWT-protected routes', () => {
    const guard = new JwtAuthGuard(jwtService);

    expect(() => guard.canActivate(contextFor({ headers: {} }))).toThrow(UnauthorizedException);
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
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const request = {
      headers: { authorization: `Bearer ${token}` },
    } as Partial<AuthenticatedRequest>;

    const guard = new OperatorAuthGuard(config, jwtService);

    expect(guard.canActivate(contextFor(request))).toBe(true);
    expect(request.wallet).toBe('GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ');
  });
});
