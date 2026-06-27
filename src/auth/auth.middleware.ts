import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { PrismaService } from '../prisma/prisma.service';

/**
 * AuthMiddleware — verifies a Stellar wallet signature on incoming requests.
 *
 * Expects three headers:
 *  - x-wallet-address: The Stellar public key (G...)
 *  - x-wallet-message: The message that was signed (must match a stored server-issued nonce)
 *  - x-wallet-signature: Base64-encoded signature of the message
 *
 * The middleware validates that x-wallet-message matches a stored, unexpired
 * AuthChallenge nonce for the given wallet address, then invalidates the nonce
 * after a successful authentication (one-time use).
 *
 * If all headers are present, the nonce is valid, and the signature verifies,
 * the wallet address is attached to req['wallet'] for downstream use.
 * If headers are absent, the request proceeds unauthenticated.
 * If headers are present but invalid, 401 is returned.
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AuthMiddleware.name);

  constructor(private readonly prisma: PrismaService) {}

  async use(req: Request & { wallet?: string }, res: Response, next: NextFunction): Promise<void> {
    const address   = req.headers['x-wallet-address'] as string | undefined;
    const signature = req.headers['x-wallet-signature'] as string | undefined;
    const message   = req.headers['x-wallet-message'] as string | undefined;

    // If no auth headers present, pass through as anonymous request
    if (!address && !signature && !message) {
      return next();
    }

    // If some but not all headers are present, reject
    if (!address || !signature || !message) {
      this.logger.warn('Partial wallet auth headers received');
      res.status(401).json({
        statusCode: 401,
        message:    'Missing wallet auth headers: x-wallet-address, x-wallet-signature, x-wallet-message all required',
      });
      return;
    }

    // Verify the message matches a stored, unexpired server-issued challenge
    let challenge: { nonce: string; expiresAt: Date } | null = null;
    try {
      challenge = await this.prisma.authChallenge.findUnique({
        where:  { walletAddress: address },
        select: { nonce: true, expiresAt: true },
      });
    } catch (err) {
      this.logger.warn(`Challenge lookup failed for ${address}: ${err}`);
      res.status(401).json({ statusCode: 401, message: 'Authentication service unavailable' });
      return;
    }

    if (!challenge) {
      this.logger.warn(`Header-auth rejected: no challenge found for ${address}`);
      res.status(401).json({
        statusCode: 401,
        message:    'No auth challenge found. Request a challenge via GET /auth/challenge first.',
      });
      return;
    }

    if (challenge.expiresAt < new Date()) {
      this.logger.warn(`Header-auth rejected: challenge expired for ${address}`);
      await this.prisma.authChallenge.delete({ where: { walletAddress: address } }).catch(() => {});
      res.status(401).json({ statusCode: 401, message: 'Auth challenge expired. Request a new challenge.' });
      return;
    }

    if (message !== challenge.nonce) {
      this.logger.warn(`Header-auth rejected: message does not match nonce for ${address}`);
      res.status(401).json({ statusCode: 401, message: 'Invalid challenge message' });
      return;
    }

    try {
      const keypair      = Keypair.fromPublicKey(address);
      const messageBytes = Buffer.from(message, 'utf8');
      const sigBytes     = Buffer.from(signature, 'base64');
      const isValid      = keypair.verify(messageBytes, sigBytes);

      if (!isValid) {
        this.logger.warn(`Invalid signature from wallet: ${address}`);
        res.status(401).json({ statusCode: 401, message: 'Invalid wallet signature' });
        return;
      }
    } catch (err) {
      this.logger.warn(`Signature verification error for ${address}: ${err}`);
      res.status(401).json({ statusCode: 401, message: 'Signature verification failed' });
      return;
    }

    // Invalidate the nonce (one-time use)
    await this.prisma.authChallenge.delete({ where: { walletAddress: address } }).catch((err) => {
      this.logger.warn(`Failed to delete challenge for ${address}: ${err}`);
    });

    req.wallet = address;
    this.logger.log(`Wallet authenticated via header: ${address}`);
    next();
  }
}
