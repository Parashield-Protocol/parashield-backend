import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminRoleGuard } from './admin-role.guard';
import { AuthenticatedRequest } from './authenticated-request';

describe('AdminRoleGuard', () => {
  function configWith(values: Record<string, string | undefined>): ConfigService {
    return {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
  }

  function contextFor(request: Partial<AuthenticatedRequest>): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  it('allows an admin JWT', () => {
    const guard = new AdminRoleGuard(configWith({ ADMIN_API_KEY: 'admin-key' }));

    expect(
      guard.canActivate(
        contextFor({ authVia: 'jwt', user: { walletAddress: 'GADMIN', role: 'admin', admin: true } }),
      ),
    ).toBe(true);
  });

  it('rejects a JWT without admin privileges', () => {
    const guard = new AdminRoleGuard(configWith({ ADMIN_API_KEY: 'admin-key' }));

    expect(() =>
      guard.canActivate(
        contextFor({ authVia: 'jwt', user: { walletAddress: 'GUSER', role: 'operator', admin: false } }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects a JWT whose payload lost the admin claims entirely', () => {
    const guard = new AdminRoleGuard(configWith({}));

    expect(() =>
      guard.canActivate(contextFor({ authVia: 'jwt', user: { walletAddress: 'GUSER' } })),
    ).toThrow(ForbiddenException);
  });

  it('allows the ADMIN_API_KEY', () => {
    const guard = new AdminRoleGuard(configWith({ ADMIN_API_KEY: 'admin-key' }));

    expect(
      guard.canActivate(contextFor({ authVia: 'api-key', apiKeySource: 'admin' })),
    ).toBe(true);
  });

  it('rejects the oracle operator key when a dedicated ADMIN_API_KEY is configured', () => {
    const guard = new AdminRoleGuard(configWith({ ADMIN_API_KEY: 'admin-key' }));

    expect(() =>
      guard.canActivate(contextFor({ authVia: 'api-key', apiKeySource: 'operator' })),
    ).toThrow(ForbiddenException);
    expect(() =>
      guard.canActivate(contextFor({ authVia: 'api-key', apiKeySource: 'operator' })),
    ).toThrow('Admin API key required');
  });

  it('falls back to the operator key when ADMIN_API_KEY is not configured', () => {
    const guard = new AdminRoleGuard(configWith({ ORACLE_OPERATOR_API_KEY: 'operator-key' }));

    expect(
      guard.canActivate(contextFor({ authVia: 'api-key', apiKeySource: 'operator' })),
    ).toBe(true);
  });

  it('fails closed when the request was not authenticated by OperatorAuthGuard', () => {
    const guard = new AdminRoleGuard(configWith({}));

    expect(() => guard.canActivate(contextFor({}))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextFor({}))).toThrow('Admin credentials required');
  });
});
