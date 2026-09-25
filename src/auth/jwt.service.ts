import { Injectable, Inject, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as jwt from "jsonwebtoken";
import * as crypto from "crypto";
import Redis from 'ioredis';

export interface JwtPayload {
  walletAddress: string;
  role?: string;
  admin?: boolean;
  iss?: string;
  aud?: string;
  iat?: number;
  exp?: number;
  jti?: string;
}

/**
 * JwtService — issues and verifies JWTs tied to Stellar wallet addresses.
 *
 * Tokens are signed with JWT_SECRET from the environment and expire in 1 hour.
 * For a financial application, short-lived tokens reduce the window of
 * unauthorized access if a token is compromised. Consider implementing
 * refresh tokens for longer sessions.
 */
@Injectable()
export class JwtService {
  private readonly logger = new Logger(JwtService.name);
  private readonly secret: string;
  private readonly tokenExpiry = "1h";
  private readonly issuer = "parashield-api";
  private readonly audience = "parashield-clients";

  constructor(private readonly config: ConfigService, @Inject('REDIS_CLIENT') private readonly redis: Redis) {
    const secret = config.get<string>("JWT_SECRET");
    if (!secret) {
      this.logger.error("JWT_SECRET environment variable is required");
      throw new Error("JWT_SECRET environment variable is required");
    }
    this.secret = secret;
  }

  get expiresIn(): string {
    return this.tokenExpiry;
  }

  /**
   * Sign a JWT for the given wallet address.
   * Token expires in 1 hour.
   */
  sign(walletAddress: string): string {
    const payload: JwtPayload = { walletAddress, jti: crypto.randomUUID() };
    const options: jwt.SignOptions = {
      algorithm: 'HS256',
      expiresIn: '1h',
      issuer: this.issuer,
      audience: this.audience,
    };
    const token = jwt.sign(payload, this.secret, options);
    this.logger.log(`JWT issued for wallet: ${walletAddress}`);
    return token;
  }

  /**
   * Sign a JWT for the given wallet address with explicit role and admin flag.
   * Useful for issuing tokens to privileged users (e.g. operators, admins).
   * Token expires in 1 hour.
   */
  signWithRole(walletAddress: string, role: string, admin = false): string {
    const payload: JwtPayload = { walletAddress, role, admin, jti: crypto.randomUUID() };
    const options: jwt.SignOptions = {
      algorithm: 'HS256',
      expiresIn: '1h',
      issuer: this.issuer,
      audience: this.audience,
    };
    const token = jwt.sign(payload, this.secret, options);
    this.logger.log(`JWT issued for wallet: ${walletAddress} (role=${role})`);
    return token;
  }

  /**
   * Verify and decode a JWT.
   * Throws UnauthorizedException if the token is invalid or expired.
   */
  verify(token: string): JwtPayload {
    try {
      // #244 — Pin the allowed algorithm explicitly. Without this, jsonwebtoken
      // falls back to trusting the `alg` header in the token itself, which opens
      // the door to algorithm-confusion attacks (e.g. `alg: none`, or a token
      // re-signed with RS256 using the HMAC secret as the public key).
      const decoded = jwt.verify(token, this.secret, {
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: this.audience,
      }) as JwtPayload & { jti?: string };
      return {
        walletAddress: decoded.walletAddress,
        role: decoded.role,
        admin: decoded.admin,
      };
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedException("Token has expired");
      }
      if (err instanceof jwt.JsonWebTokenError) {
        throw new UnauthorizedException("Invalid token");
      }
      if (err instanceof jwt.NotBeforeError) {
        throw new UnauthorizedException("Token not yet valid");
      }
      throw new UnauthorizedException("Token verification failed");
    }
  }

  async verifyAsync(token: string): Promise<JwtPayload> {
    const payload = this.verify(token);
    const decoded = jwt.decode(token) as JwtPayload & { jti?: string };
    if (decoded.jti && await this.redis.exists(`jwt:revoked:${decoded.jti}`)) {
      throw new UnauthorizedException("Token has been revoked");
    }
    return payload;
  }

  async revoke(token: string): Promise<void> {
    const decoded = jwt.decode(token) as (JwtPayload & { jti?: string }) | null;
    if (!decoded?.jti || !decoded.exp) throw new UnauthorizedException("Invalid token");
    const ttl = Math.max(decoded.exp - Math.floor(Date.now() / 1000), 1);
    await this.redis.set(`jwt:revoked:${decoded.jti}`, '1', 'EX', ttl);
  }
}
