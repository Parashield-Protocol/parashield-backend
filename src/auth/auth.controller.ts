import { Controller, Post, Body, UnauthorizedException, Logger, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { Keypair } from '@stellar/stellar-sdk';
import { JwtService } from './jwt.service';

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

  constructor(private readonly jwtService: JwtService) {}

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

    const token = this.jwtService.sign(walletAddress);
    this.logger.log(`Login successful: wallet=${walletAddress}`);

    return {
      success: true,
      data: {
        token,
        walletAddress,
        expiresIn: '7d',
      },
    };
  }
}
