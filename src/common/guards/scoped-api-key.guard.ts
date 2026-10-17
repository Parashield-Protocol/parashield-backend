import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  TooManyRequestsException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { createHash, timingSafeEqual } from "crypto";

export const API_KEY_SCOPES = "apiKeyScopes";
export const RequireApiKeyScopes = (...scopes: string[]) =>
  SetMetadata(API_KEY_SCOPES, scopes);

interface KeyDefinition {
  key: string;
  scopes: string[];
}

interface RateWindow {
  count: number;
  resetAt: number;
}

/**
 * Authenticates API keys configured in API_KEYS and enforces endpoint scopes.
 *
 * API_KEYS is a JSON object mapping each key to its scopes:
 * {"key-value":["oracle:read","claims:write"]}
 */
@Injectable()
export class ScopedApiKeyGuard implements CanActivate {
  private readonly windows = new Map<string, RateWindow>();
  private readonly windowMs = 60_000;
  private readonly maxRequests = 60;

  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      apiKeyScopes?: string[];
    }>();
    const provided = this.header(request.headers, "x-api-key");
    if (!provided) throw new UnauthorizedException("API key required");

    const definition = this.findDefinition(provided);
    if (!definition) throw new UnauthorizedException("Invalid API key");

    this.consume(definition.key);

    const required =
      this.reflector.getAllAndOverride<string[]>(API_KEY_SCOPES, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (!required.every((scope) => definition.scopes.includes("*") || definition.scopes.includes(scope))) {
      throw new ForbiddenException("API key does not have the required scope");
    }

    request.apiKeyScopes = definition.scopes;
    return true;
  }

  private findDefinition(provided: string): KeyDefinition | undefined {
    const raw = this.config.get<string>("API_KEYS");
    if (!raw) return undefined;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }

    for (const [key, scopes] of Object.entries(parsed)) {
      if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) continue;
      if (this.constantTimeEqual(provided, key)) return { key, scopes: scopes as string[] };
    }
    return undefined;
  }

  private consume(key: string): void {
    const now = Date.now();
    const fingerprint = createHash("sha256").update(key).digest("hex");
    const current = this.windows.get(fingerprint);
    if (!current || now >= current.resetAt) {
      this.windows.set(fingerprint, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    if (current.count >= this.maxRequests) {
      throw new TooManyRequestsException("API key rate limit exceeded");
    }
    current.count += 1;
  }

  private constantTimeEqual(left: string, right: string): boolean {
    const leftHash = createHash("sha256").update(left).digest();
    const rightHash = createHash("sha256").update(right).digest();
    return timingSafeEqual(leftHash, rightHash);
  }

  private header(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | undefined {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
}
