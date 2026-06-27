import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthenticatedRequest } from './authenticated-request';
import { JwtService } from './jwt.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (request.wallet) {
      return true;
    }

    const token = this.getBearerToken(request);
    const payload = this.jwtService.verify(token);

    request.wallet = payload.walletAddress;
    request.user = payload;
    return true;
  }

  private getBearerToken(request: AuthenticatedRequest): string {
    const header = request.headers.authorization;
    if (!header) {
      throw new UnauthorizedException('Missing Authorization bearer token');
    }

    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Invalid Authorization bearer token');
    }

    return token;
  }
}
