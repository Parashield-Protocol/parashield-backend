import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerStorage,
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerRequest,
} from '@nestjs/throttler';
import { JwtService } from '../../auth/jwt.service';

/**
 * UserThrottlerGuard — tracks the global rate limit per authenticated user
 * (wallet address) instead of per IP address whenever the caller's identity
 * is available, falling back to IP for anonymous requests.
 *
 * Per-IP limiting alone lets a single user cycling through IPs (or many
 * users sharing one IP, e.g. behind NAT/a corporate proxy) evade or trigger
 * the shared limit. Keying on wallet address closes that gap for
 * authenticated traffic while leaving anonymous traffic protected as before.
 *
 * Wallet identity is read from, in order:
 *  1. `req.wallet` — already set by AuthMiddleware for wallet-signature auth,
 *     which runs before guards.
 *  2. A `Bearer` JWT in the Authorization header — decoded here directly
 *     since JwtAuthGuard (which normally sets `req.wallet`) is a route-level
 *     guard that has not run yet when this global guard executes. Decoding
 *     is best-effort: an invalid/expired token just falls through to IP
 *     tracking rather than rejecting the request (that is JwtAuthGuard's job).
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  private static readonly AUTHENTICATED_LIMIT_MULTIPLIER = 5;

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwtService: JwtService,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    if (typeof req.wallet === 'string' && req.wallet) {
      return `user:${req.wallet}`;
    }

    const authHeader = req.headers?.authorization as string | undefined;
    const [scheme, token] = authHeader?.split(' ') ?? [];
    if (scheme === 'Bearer' && token) {
      try {
        const payload = await this.jwtService.verifyAsync(token);
        if (payload?.walletAddress) {
          return `user:${payload.walletAddress}`;
        }
      } catch {
        // Invalid/expired token — fall through to IP-based tracking.
      }
    }

    return super.getTracker(req);
  }

  /**
   * Anonymous requests retain the configured IP quota. Authenticated requests
   * receive a separate, per-wallet bucket with a five-times-higher quota.
   */
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { req } = this.getRequestResponse(requestProps.context);
    const tracker = await this.getTracker(req);
    const authenticated = tracker.startsWith('user:');

    return super.handleRequest({
      ...requestProps,
      limit: authenticated
        ? requestProps.limit * UserThrottlerGuard.AUTHENTICATED_LIMIT_MULTIPLIER
        : requestProps.limit,
      getTracker: async () => tracker,
    });
  }
}
