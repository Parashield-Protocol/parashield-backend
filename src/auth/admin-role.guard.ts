import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticatedRequest } from './authenticated-request';

/**
 * AdminRoleGuard — authorization for admin-only routes (e.g. product
 * management). It runs after OperatorAuthGuard, which authenticates the
 * caller and records *how* they authenticated on the request:
 *
 *  - `authVia: 'jwt'`     → the token must carry admin privileges
 *                            (`role === 'admin'` or `admin === true`).
 *  - `authVia: 'api-key'` → ADMIN_API_KEY always counts as admin; the oracle
 *                            key (ORACLE_OPERATOR_API_KEY) only counts when no
 *                            dedicated ADMIN_API_KEY is configured, so
 *                            oracle-feed automation cannot manage products in
 *                            deployments that set both keys.
 *
 * Fails closed: a request that did not come through OperatorAuthGuard (or an
 * unknown auth method) is rejected with 403 rather than trusted.
 */
@Injectable()
export class AdminRoleGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (request.authVia === 'jwt') {
      if (request.user?.admin === true || request.user?.role === 'admin') return true;
      throw new ForbiddenException('Admin role required');
    }

    if (request.authVia === 'api-key') {
      if (request.apiKeySource === 'admin') return true;
      // Single-key deployments only configure ORACLE_OPERATOR_API_KEY; it has
      // to keep working there, otherwise admin routes would be unreachable.
      if (!this.config.get<string>('ADMIN_API_KEY')) return true;
      throw new ForbiddenException(
        'Admin API key required: ORACLE_OPERATOR_API_KEY is not authorized for this endpoint',
      );
    }

    throw new ForbiddenException('Admin credentials required');
  }
}
