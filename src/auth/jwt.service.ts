import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';

export interface JwtPayload {
  walletAddress: string;
  role?: string;
  admin?: boolean;
  iat?: number;
  exp?: number;
}

/**
 * JwtService — issues and verifies JWTs tied to Stellar wallet addresses.
 *
 * Tokens are signed with JWT_SECRET from the environment and expire in 7 days.
 * The token payload contains the wallet address, which is used to identify
 * the authenticated user on protected endpoints.
 */
@Injectable()
export class JwtService {
  private readonly logger = new Logger(JwtService.name);
  private readonly secret: string;
  private readonly tokenExpiry = '7d';

  constructor(private readonly config: ConfigService) {
    const secret = config.get<string>('JWT_SECRET');
    if (!secret) {
      this.logger.error('JWT_SECRET environment variable is required');
      throw new Error('JWT_SECRET environment variable is required');
    }
    this.secret = secret;
  }

  get expiresIn(): string {
    return this.tokenExpiry;
  }

  /**
   * Sign a JWT for the given wallet address.
   * Token expires in 7 days.
   */
  sign(walletAddress: string): string {
    const payload: JwtPayload = { walletAddress };
    const token = jwt.sign(payload, this.secret, { expiresIn: this.expiresIn });
    this.logger.log(`JWT issued for wallet: ${walletAddress}`);
    return token;
  }

  /**
   * Sign a JWT for the given wallet address with explicit role and admin flag.
   * Useful for issuing tokens to privileged users (e.g. operators, admins).
   * Token expires in 7 days.
   */
  signWithRole(walletAddress: string, role: string, admin = false): string {
    const payload: JwtPayload = { walletAddress, role, admin };
    const token = jwt.sign(payload, this.secret, { expiresIn: this.expiresIn });
    this.logger.log(`JWT issued for wallet: ${walletAddress} (role=${role})`);
    return token;
  }

  /**
   * Verify and decode a JWT.
   * Throws UnauthorizedException if the token is invalid or expired.
   */
  verify(token: string): JwtPayload {
    try {
      const decoded = jwt.verify(token, this.secret) as JwtPayload;
      return {
        walletAddress: decoded.walletAddress,
        role: decoded.role,
        admin: decoded.admin,
      };
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedException('Token has expired');
      }
      if (err instanceof jwt.JsonWebTokenError) {
        throw new UnauthorizedException('Invalid token');
      }
      throw new UnauthorizedException('Token verification failed');
    }
  }
}
