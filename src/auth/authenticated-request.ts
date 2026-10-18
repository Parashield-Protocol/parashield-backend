import { Request } from 'express';
import { JwtPayload } from './jwt.service';

/** How OperatorAuthGuard authenticated the caller. */
export type AuthVia = 'jwt' | 'api-key';

/** Which configured API key matched: the admin key or the oracle operator key. */
export type ApiKeySource = 'admin' | 'operator';

export type AuthenticatedRequest = Request & {
  wallet?: string;
  user?: JwtPayload;
  // Set by OperatorAuthGuard so a following authorization guard (e.g.
  // AdminRoleGuard) can tell admin credentials from operator-only ones.
  authVia?: AuthVia;
  apiKeySource?: ApiKeySource;
};
