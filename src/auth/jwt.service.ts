import { Injectable, Inject, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as jwt from "jsonwebtoken";
import * as crypto from "crypto";
import Redis from 'ioredis';

import { validateJwtSecret } from "./jwt-secret.validator";

export interface JwtPayload {
  walletAddress: string;
  type?: "access" | "refresh";
  role?: string;
  admin?: boolean;
  iss?: string;
  aud?: string;
  iat?: number;
  exp?: number;
  jti?: string;
  /** #724 — Token family ID for refresh token rotation tracking. */
  family?: string;
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
    const validation = validateJwtSecret(secret);
    if (!validation.valid) {
      this.logger.error(`Fatal Error: ${validation.error}`);
      throw new Error(validation.error);
    }
    this.secret = secret!;
  }

  get expiresIn(): string {
    return this.tokenExpiry;
  }

  /**
   * Sign a JWT for the given wallet address.
   * Token expires in 1 hour.
   */
  sign(walletAddress: string): string {
    const payload: JwtPayload = { walletAddress, type: "access", jti: crypto.randomUUID() };
    const options: jwt.SignOptions = {
      algorithm: 'HS256',
      expiresIn: '1h',
      issuer: this.issuer,
      audience: this.audience,
    };
    const token = jwt.sign(payload, this.secret, options);
    // #543 — the wallet address is not logged here; the controller that
    // issues the token records the login once.
    return token;
  }

  /**
   * Sign a JWT for the given wallet address with explicit role and admin flag.
   * Useful for issuing tokens to privileged users (e.g. operators, admins).
   * Token expires in 1 hour.
   */
  signWithRole(walletAddress: string, role: string, admin = false): string {
    const payload: JwtPayload = { walletAddress, type: "access", role, admin, jti: crypto.randomUUID() };
    const options: jwt.SignOptions = {
      algorithm: 'HS256',
      expiresIn: '1h',
      issuer: this.issuer,
      audience: this.audience,
    };
    const token = jwt.sign(payload, this.secret, options);
    this.logger.log(`JWT issued (role=${role})`);
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
      }) as JwtPayload & { jti?: string; type?: string };

      if (decoded.type === "refresh") {
        throw new UnauthorizedException("Cannot use refresh token as access token");
      }

      return {
        walletAddress: decoded.walletAddress,
        type: decoded.type,
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

  // ── #724 — Refresh token rotation with family invalidation ──────────────

  /**
   * Issue a refresh token tied to a token family. The family ID is shared
   * across all rotations so reuse of any token in the family can invalidate
   * the entire chain.
   */
  signRefresh(walletAddress: string, family?: string): string {
    const tokenFamily = family ?? crypto.randomUUID();
    const payload: JwtPayload = {
      walletAddress,
      type: "refresh",
      family: tokenFamily,
      jti: crypto.randomUUID(),
    };
    const options: jwt.SignOptions = {
      algorithm: 'HS256',
      expiresIn: '7d',
      issuer: this.issuer,
      audience: this.audience,
    };
    return jwt.sign(payload, this.secret, options);
  }

  /**
   * Rotate a refresh token: verify the old token, detect reuse (token
   * already rotated), invalidate the entire family on reuse, and issue a
   * new refresh token in the same family.
   *
   * #724 — When a refresh token is reused (already rotated), the entire
   * token family is invalidated to prevent attackers from keeping stolen
   * tokens valid after rotation.
   */
  async rotateRefresh(oldToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    let decoded: JwtPayload & { jti?: string };
    try {
      decoded = jwt.verify(oldToken, this.secret, {
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: this.audience,
      }) as JwtPayload & { jti?: string };
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }

    if (decoded.type !== "refresh") {
      throw new UnauthorizedException("Not a refresh token");
    }

    const jti = decoded.jti;
    const family = decoded.family;

    if (!jti || !family) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    // Check if this token was already rotated (reuse detection)
    const rotationKey = `jwt:rotated:${jti}`;
    const wasRotated = await this.redis.exists(rotationKey);

    if (wasRotated) {
      // #724 — Token reuse detected: invalidate the entire family.
      this.logger.warn(
        `Refresh token reuse detected for family ${family} — invalidating entire token family`,
      );
      await this.invalidateFamily(family);
      throw new UnauthorizedException("Refresh token reuse detected — all tokens in this family have been invalidated");
    }

    // Mark this token as rotated (consumed)
    const ttl = Math.max(decoded.exp! - Math.floor(Date.now() / 1000), 1);
    await this.redis.set(rotationKey, '1', 'EX', ttl);

    // Issue new tokens in the same family
    const accessToken = this.sign(decoded.walletAddress);
    const refreshToken = this.signRefresh(decoded.walletAddress, family);

    return { accessToken, refreshToken };
  }

  /**
   * Invalidate all tokens in a family (used on reuse detection).
   * Marks the family as revoked; all subsequent tokens in the family
   * are rejected.
   */
  async invalidateFamily(family: string): Promise<void> {
    await this.redis.set(`jwt:family:revoked:${family}`, '1', 'EX', 7 * 24 * 3600);
    this.logger.warn(`Token family ${family} has been invalidated`);
  }

  /**
   * Check if a token family has been revoked.
   */
  async isFamilyRevoked(family: string): Promise<boolean> {
    return (await this.redis.exists(`jwt:family:revoked:${family}`)) === 1;
  }
}
