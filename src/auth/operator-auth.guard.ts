import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from './jwt.service';
import { AuthenticatedRequest } from './authenticated-request';

interface FailureRecord {
  count: number;
  resetAt: number;
}

const RATE_LIMIT_WINDOW_MS = 60_000;  // 1 minute
const RATE_LIMIT_MAX_FAILURES = 5;

@Injectable()
export class OperatorAuthGuard implements CanActivate {
  private readonly failureMap = new Map<string, FailureRecord>();

  constructor(
    private readonly config: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const ip = this.getClientIp(request);

    this.checkRateLimit(ip);

    if (this.hasValidApiKey(request)) {
      this.resetFailures(ip);
      return true;
    }

    const token = this.getOptionalBearerToken(request);
    if (!token) {
      this.recordFailure(ip);
      throw new UnauthorizedException('Operator API key or admin bearer token required');
    }

    try {
      const payload = this.jwtService.verify(token);
      if (payload.admin !== true && payload.role !== 'admin') {
        this.recordFailure(ip);
        throw new UnauthorizedException('Admin bearer token required');
      }
      this.resetFailures(ip);
      request.wallet = payload.walletAddress;
      request.user = payload;
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      this.recordFailure(ip);
      throw new UnauthorizedException('Invalid bearer token');
    }
  }

  private checkRateLimit(ip: string): void {
    const record = this.failureMap.get(ip);
    if (!record) return;

    if (Date.now() > record.resetAt) {
      this.failureMap.delete(ip);
      return;
    }

    if (record.count >= RATE_LIMIT_MAX_FAILURES) {
      throw new HttpException(
        'Too many failed authentication attempts. Try again in 1 minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private recordFailure(ip: string): void {
    const now = Date.now();
    const existing = this.failureMap.get(ip);

    if (!existing || now > existing.resetAt) {
      this.failureMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    } else {
      existing.count += 1;
    }
  }

  private resetFailures(ip: string): void {
    this.failureMap.delete(ip);
  }

  private getClientIp(request: AuthenticatedRequest): string {
    const forwarded = request.headers['x-forwarded-for'];
    const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    return ip?.trim() ?? (request as any).ip ?? 'unknown';
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
