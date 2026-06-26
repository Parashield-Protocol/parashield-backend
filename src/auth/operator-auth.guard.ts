import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from './jwt.service';
import { AuthenticatedRequest } from './authenticated-request';

@Injectable()
export class OperatorAuthGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (this.hasValidApiKey(request)) {
      return true;
    }

    const token = this.getOptionalBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Operator API key or admin bearer token required');
    }

    const payload = this.jwtService.verify(token);
    if (payload.admin !== true && payload.role !== 'admin') {
      throw new UnauthorizedException('Admin bearer token required');
    }

    request.wallet = payload.walletAddress;
    request.user = payload;
    return true;
  }

  private hasValidApiKey(request: AuthenticatedRequest): boolean {
    const configuredKey =
      this.config.get<string>('ORACLE_OPERATOR_API_KEY') ??
      this.config.get<string>('ADMIN_API_KEY');

    if (!configuredKey) {
      return false;
    }

    const providedKey = this.getHeader(request, 'x-api-key') ?? this.getHeader(request, 'x-admin-api-key');
    return providedKey === configuredKey;
  }

  private getOptionalBearerToken(request: AuthenticatedRequest): string | null {
    const header = request.headers.authorization;
    if (!header) {
      return null;
    }

    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Invalid Authorization bearer token');
    }

    return token;
  }

  private getHeader(request: AuthenticatedRequest, name: string): string | undefined {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
}
