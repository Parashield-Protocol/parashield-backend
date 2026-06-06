import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { Keypair } from '@stellar/stellar-sdk';

/**
 * AuthMiddleware — verifies a Stellar wallet signature on incoming requests.
 *
 * Expects three headers:
 *  - x-wallet-address: The Stellar public key (G...)
 *  - x-wallet-message: The message that was signed
 *  - x-wallet-signature: Base64-encoded signature of the message
 *
 * If all headers are present and the signature is valid, the wallet address
 * is attached to req['wallet'] for downstream use.
 * If headers are absent, the request proceeds unauthenticated.
 * If headers are present but invalid, 401 is returned.
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AuthMiddleware.name);

  use(req: Request & { wallet?: string }, res: Response, next: NextFunction): void {
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

    try {
      const keypair       = Keypair.fromPublicKey(address);
      const messageBytes  = Buffer.from(message, 'utf8');
      const sigBytes      = Buffer.from(signature, 'base64');
      const isValid       = keypair.verify(messageBytes, sigBytes);

      if (!isValid) {
        this.logger.warn(`Invalid signature from wallet: ${address}`);
        res.status(401).json({
          statusCode: 401,
          message:    'Invalid wallet signature',
        });
        return;
      }

      req.wallet = address;
      this.logger.log(`Wallet authenticated: ${address}`);
      next();
    } catch (err) {
      this.logger.warn(`Signature verification error for ${address}: ${err}`);
      res.status(401).json({
        statusCode: 401,
        message:    'Signature verification failed',
      });
    }
  }
}
