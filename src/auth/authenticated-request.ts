import { Request } from 'express';
import { JwtPayload } from './jwt.service';

export type AuthenticatedRequest = Request & {
  wallet?: string;
  user?: JwtPayload;
};
