import {
  Controller,
  Post,
  Body,
  UnauthorizedException,
  BadRequestException,
  Logger,
  HttpCode,
  HttpStatus,
  Get,
  Query,
  Inject,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { ApiErrorResponse } from '../common/swagger/api-error-responses';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { Keypair } from '@stellar/stellar-sdk';
import { JwtService } from './jwt.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletLoginDto } from './dto/wallet-login.dto';
import * as crypto from 'crypto';
import { timingSafeEqual } from 'crypto';

// Auth endpoints are brute-force/enumeration targets, so they get a tighter
// limit than the app-wide default (60 req/60s) configured in app.module.ts.
const AUTH_THROTTLE = { default: { limit: 10, ttl: 60000 } };
const DEFAULT_NONCE_TTL_SECONDS = 300; // 5 minutes

/**
 * AuthController — wallet-based authentication endpoint.
 *
 * The client requests a challenge nonce (stored in Redis with TTL), signs it
 * with their Stellar keypair (Ed25519), and submits it to /login.
 * Nonces are single-use and consumed atomically to prevent replay attacks.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Helper to atomically consume the nonce from Redis for a wallet address.
   * Uses Redis GETDEL (Redis >= 6.2) or an atomic Lua script fallback.
   * Consuming the nonce atomically guarantees that concurrent login requests
   * cannot both succeed using the same nonce.
   */
  private async consumeNonce(wallet: string): Promise<string | null> {
    const key = `auth:nonce:${wallet}`;
    try {
      if (typeof this.redis.getdel === 'function') {
        const val = await this.redis.getdel(key);
        if (val !== undefined && val !== null) return val;
      }
    } catch {
      // Fallback to Lua script if GETDEL is not supported on older Redis versions
    }

    const lua = `
      local val = redis.call('GET', KEYS[1])
      if val then
        redis.call('DEL', KEYS[1])
      end
      return val
    `;
    try {
      const res = await this.redis.eval(lua, 1, key);
      return (res as string | null) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * GET /api/v1/auth/challenge
   * Issue a server-generated nonce for a given wallet address.
   */
  @Get('challenge')
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Obtain a server-issued nonce before login',
    description:
      'Step 1 of 2 in the wallet-based auth flow. Returns a cryptographically random ' +
      'nonce tied to the given wallet address. The nonce expires in 5 minutes and must ' +
      'be signed by the wallet private key, then submitted to POST /auth/login.',
  })
  @ApiResponse({ status: 200, description: 'Returns the challenge nonce' })
  @ApiErrorResponse(400, 'Invalid or missing Stellar wallet address (must match /^G[A-Z2-7]{55}$/).', undefined, 'Invalid or missing Stellar wallet address')
  @ApiErrorResponse(429, 'Rate limit exceeded — auth endpoints allow 10 req / 60 s.', undefined, 'Too many requests. Please try again later.')
  async getChallenge(@Query('wallet') wallet: string) {
    if (!wallet || !/^G[A-Z2-7]{55}$/.test(wallet)) {
      throw new BadRequestException('Invalid or missing Stellar wallet address');
    }

    // Generate a secure, cryptographically random nonce (32 bytes = 64 hex characters)
    const nonce = crypto.randomBytes(32).toString('hex');
    const ttlSeconds = parseInt(
      this.configService?.get<string>('AUTH_NONCE_TTL_SECONDS') ?? `${DEFAULT_NONCE_TTL_SECONDS}`,
      10,
    );
    const key = `auth:nonce:${wallet}`;

    // Store in Redis with TTL bound to the specific wallet address
    await this.redis.set(key, nonce, 'EX', ttlSeconds);

    // Also mirror to DB for backward compatibility if prisma is configured
    if (this.prisma?.authChallenge) {
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      await this.prisma.authChallenge.upsert({
        where: { walletAddress: wallet },
        update: { nonce, expiresAt, createdAt: new Date() },
        create: { walletAddress: wallet, nonce, expiresAt },
      }).catch((err) => {
        this.logger.warn(`Failed to mirror challenge to DB: ${err.message}`);
      });
    }

    return {
      success: true,
      data: nonce,
    };
  }

  /**
   * POST /api/v1/auth/login
   * Verify a Stellar wallet signature and return a JWT.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Authenticate with a Stellar wallet signature and receive a JWT',
    description:
      'Step 2 of 2 in the wallet-based auth flow. Sign the nonce obtained from ' +
      'GET /auth/challenge with your Stellar private key (Ed25519), base64-encode the ' +
      'signature, and submit it here. On success, returns a signed JWT to use as ' +
      'Bearer token in subsequent authenticated requests.',
  })
  @ApiBody({ type: WalletLoginDto })
  @ApiResponse({ status: 200, description: 'Returns a JWT token for the authenticated wallet' })
  @ApiErrorResponse(401, 'Invalid, expired, or missing wallet signature / challenge.', undefined, 'Invalid or expired authentication challenge')
  @ApiErrorResponse(429, 'Rate limit exceeded — auth endpoints allow 10 req / 60 s.', undefined, 'Too many requests. Please try again later.')
  async login(@Body() dto: WalletLoginDto) {
    const { walletAddress, signature, message } = dto;

    if (!walletAddress || !/^G[A-Z2-7]{55}$/.test(walletAddress)) {
      this.logger.warn(`Login rejected: invalid wallet address format for ${walletAddress}`);
      throw new UnauthorizedException('Invalid or expired authentication challenge');
    }

    // Atomically consume the nonce from Redis keyed by wallet address.
    // Decision: We deliberately consume the nonce BEFORE signature verification.
    // This is safer because consuming the nonce on any verification attempt
    // (success or failure) prevents replay attacks, prevents brute-forcing
    // signatures against a valid nonce, and eliminates race conditions.
    let storedNonce = await this.consumeNonce(walletAddress);

    // Fallback to database challenge if Redis did not have the key (e.g. during migration)
    if (!storedNonce && this.prisma?.authChallenge) {
      try {
        const challenge = await this.prisma.authChallenge.findUnique({
          where: { walletAddress },
        });
        if (challenge) {
          await this.prisma.authChallenge.delete({ where: { walletAddress } }).catch(() => {});
          if (challenge.expiresAt >= new Date()) {
            storedNonce = challenge.nonce;
          }
        }
      } catch {
        // Ignore DB fallback lookup error
      }
    }

    // Reject unknown, expired, reused, and wrong-address nonces with the same generic 401
    if (!storedNonce) {
      this.logger.warn(`Login rejected: no active challenge found (or expired/reused) for ${walletAddress}`);
      throw new UnauthorizedException('Invalid or expired authentication challenge');
    }

    // Ensure the signed message actually matches the stored nonce.
    // Constant-time comparison prevents timing side-channel leaks.
    const msgBuf = Buffer.from(message, 'utf8');
    const nonceBuf = Buffer.from(storedNonce, 'utf8');
    const nonceMatches =
      msgBuf.length === nonceBuf.length && timingSafeEqual(msgBuf, nonceBuf);
    if (!nonceMatches) {
      this.logger.warn(`Login rejected: message does not match stored nonce for ${walletAddress}`);
      throw new UnauthorizedException('Invalid or expired authentication challenge');
    }

    try {
      const keypair = Keypair.fromPublicKey(walletAddress);
      const messageBytes = Buffer.from(message, 'utf8');
      const sigBytes = Buffer.from(signature, 'base64');
      const isValid = keypair.verify(messageBytes, sigBytes);

      if (!isValid) {
        this.logger.warn(`Login rejected: invalid signature from ${walletAddress}`);
        throw new UnauthorizedException('Invalid or expired authentication challenge');
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      this.logger.warn(`Signature verification error: ${err}`);
      throw new UnauthorizedException('Invalid or expired authentication challenge');
    }

    const token = this.jwtService.sign(walletAddress);
    this.logger.log(`Login successful: wallet=${walletAddress}`);

    return {
      success: true,
      data: {
        token,
        walletAddress,
        expiresIn: this.jwtService.expiresIn,
      },
    };
  }
}


