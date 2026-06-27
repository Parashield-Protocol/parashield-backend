import { Controller, Post, Body, UnauthorizedException, Logger, HttpCode, HttpStatus, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { Keypair } from '@stellar/stellar-sdk';
import { JwtService } from './jwt.service';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';

class WalletLoginDto {
  @IsString()
  @Matches(/^G[A-Z2-7]{55}$/, { message: 'Invalid Stellar wallet address' })
  walletAddress: string;

  @IsString()
  signature: string;

  @IsString()
  message: string;
}

/**
 * AuthController — wallet-based authentication endpoint.
 *
 * The client signs a known message with their Stellar keypair.
 * The server verifies the signature and issues a JWT on success.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * GET /api/v1/auth/challenge
   * Issue a server-generated nonce for a given wallet address.
   */
  @Get('challenge')
  @ApiOperation({ summary: 'Obtain a server-issued nonce before login' })
  @ApiResponse({ status: 200, description: 'Returns the challenge nonce' })
  @ApiResponse({ status: 400, description: 'Invalid wallet address' })
  async getChallenge(@Query('wallet') wallet: string) {
    if (!wallet || !/^G[A-Z2-7]{55}$/.test(wallet)) {
      throw new UnauthorizedException('Invalid or missing Stellar wallet address');
    }

    // Generate a secure, cryptographically random nonce
    const nonce = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes TTL

    // Proactively clean up any expired challenges to prevent DB bloat
    await this.prisma.authChallenge.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    }).catch((err) => {
      this.logger.warn(`Error cleaning up expired challenges: ${err.message}`);
    });

    // Store the nonce keyed by wallet address (upsert if they request again)
    await this.prisma.authChallenge.upsert({
      where: { walletAddress: wallet },
      update: { nonce, expiresAt, createdAt: new Date() },
      create: { walletAddress: wallet, nonce, expiresAt },
    });

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
  @ApiOperation({ summary: 'Authenticate with a Stellar wallet signature and receive a JWT' })
  @ApiResponse({ status: 200, description: 'Returns a JWT token for the authenticated wallet' })
  @ApiResponse({ status: 401, description: 'Invalid or missing wallet signature' })
  async login(@Body() dto: WalletLoginDto) {
    const { walletAddress, signature, message } = dto;

    // Fetch the challenge from DB
    const challenge = await this.prisma.authChallenge.findUnique({
      where: { walletAddress },
    });

    if (!challenge) {
      this.logger.warn(`Login rejected: no challenge found for ${walletAddress}`);
      throw new UnauthorizedException('No auth challenge found. Please request a challenge first.');
    }

    // Verify it is not expired
    if (challenge.expiresAt < new Date()) {
      await this.prisma.authChallenge.delete({ where: { walletAddress } }).catch(() => {});
      this.logger.warn(`Login rejected: challenge expired for ${walletAddress}`);
      throw new UnauthorizedException('Auth challenge expired. Please request a new one.');
    }

    // Verify that the signed message equals the stored nonce
    if (message !== challenge.nonce) {
      this.logger.warn(`Login rejected: message does not match stored nonce for ${walletAddress}`);
      throw new UnauthorizedException('Invalid challenge message');
    }

    try {
      const keypair      = Keypair.fromPublicKey(walletAddress);
      const messageBytes = Buffer.from(message, 'utf8');
      const sigBytes     = Buffer.from(signature, 'base64');
      const isValid      = keypair.verify(messageBytes, sigBytes);

      if (!isValid) {
        this.logger.warn(`Login rejected: invalid signature from ${walletAddress}`);
        throw new UnauthorizedException('Invalid wallet signature');
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      this.logger.warn(`Signature verification error: ${err}`);
      throw new UnauthorizedException('Signature verification failed');
    }

    // Invalidate the nonce only after successful verification (one-time use).
    await this.prisma.authChallenge.delete({ where: { walletAddress } }).catch((err) => {
      this.logger.warn(`Failed to delete challenge for ${walletAddress}: ${err.message}`);
    });

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

