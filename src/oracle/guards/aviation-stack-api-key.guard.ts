import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AviationStackApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const apiKey = this.config.get<string>('AVIATIONSTACK_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException('Flight delay oracle service is unavailable because AVIATIONSTACK_API_KEY is not configured.');
    }
    return true;
  }
}
