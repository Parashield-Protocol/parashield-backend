import { CanActivate, ExecutionContext, Injectable, InternalServerErrorException, UnauthorizedException, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { JwtService } from './jwt.service';
import { AuthenticatedRequest } from './authenticated-request';
import Redis from 'ioredis';

interface FailureRecord {
  count: number;
  resetAt: number;
}

const RATE_LIMIT_WINDOW_MS = 60_000;  // 1 minute
const RATE_LIMIT_MAX_FAILURES = 5;
const REDIS_KEY_PREFIX = 'auth:operator:failures:';

@Injectable()
export class OperatorAuthGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly jwtService: JwtService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const ip = this.getClientIp(request);

    await this.checkRateLimit(ip);

    if (this.hasValidApiKey(request)) {
      await this.resetFailures(ip);
      return true;
    }

    const token = this.getOptionalBearerToken(request);
    if (!token) {
      await this.recordFailure(ip);
      throw new UnauthorizedException('Operator API key or admin bearer token required');
    }

    try {
      const payload = this.jwtService.verify(token);
      if (payload.admin !== true && payload.role !== 'admin') {
        await this.recordFailure(ip);
        throw new UnauthorizedException('Admin bearer token required');
      }
      await this.resetFailures(ip);
      request.wallet = payload.walletAddress;
      request.user = payload;
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      await this.recordFailure(ip);
      throw new UnauthorizedException('Invalid bearer token');
    }
  }

  private async checkRateLimit(ip: string): Promise<void> {
    const key = `${REDIS_KEY_PREFIX}${ip}`;
    const recordStr = await this.redis.get(key);
    
    if (!recordStr) return;

    const record: FailureRecord = JSON.parse(recordStr);
    
    if (Date.now() > record.resetAt) {
      await this.redis.del(key);
      return;
    }

    if (record.count >= RATE_LIMIT_MAX_FAILURES) {
      throw new HttpException(
        'Too many failed authentication attempts. Try again in 1 minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async recordFailure(ip: string): Promise<void> {
    const key = `${REDIS_KEY_PREFIX}${ip}`;
    const now = Date.now();
    const recordStr = await this.redis.get(key);

    if (!recordStr) {
      const newRecord: FailureRecord = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
      await this.redis.set(key, JSON.stringify(newRecord), 'PX', RATE_LIMIT_WINDOW_MS);
    } else {
      const record: FailureRecord = JSON.parse(recordStr);
      if (now > record.resetAt) {
        const newRecord: FailureRecord = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
        await this.redis.set(key, JSON.stringify(newRecord), 'PX', RATE_LIMIT_WINDOW_MS);
      } else {
        record.count += 1;
        const ttl = record.resetAt - now;
        await this.redis.set(key, JSON.stringify(record), 'PX', Math.max(ttl, 1000));
      }
    }
  }

  private async resetFailures(ip: string): Promise<void> {
    const key = `${REDIS_KEY_PREFIX}${ip}`;
    await this.redis.del(key);
  }

  private getClientIp(request: AuthenticatedRequest): string {
    const forwarded = request.headers['x-forwarded-for'];
    const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    return ip?.trim() ?? request.ip ?? 'unknown';
  }

  private hasValidApiKey(request: AuthenticatedRequest): boolean {
    const configuredKey =
      this.config.get<string>('ORACLE_OPERATOR_API_KEY') ??
      this.config.get<string>('ADMIN_API_KEY');

    if (!configuredKey) {
      throw new InternalServerErrorException(
        'Server misconfiguration: ORACLE_OPERATOR_API_KEY is not set',
      );
    }

    const providedKey = this.getHeader(request, 'x-api-key') ?? this.getHeader(request, 'x-admin-api-key');
    if (!providedKey) return false;

    return this.constantTimeEqual(providedKey, configuredKey);
  }

  // #181 — a static, long-lived secret checked on every request is a prime
  // target for a byte-by-byte timing attack under plain string `===`.
  // crypto.timingSafeEqual requires equal-length buffers (it throws
  // otherwise), so the length check must happen first — but done as a
  // simple early return, not a thrown exception, per the fix suggested in
  // the issue.
  private constantTimeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
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
