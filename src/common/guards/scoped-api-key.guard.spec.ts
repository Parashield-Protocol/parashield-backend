import { ExecutionContext, ForbiddenException, TooManyRequestsException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { RequireApiKeyScopes, ScopedApiKeyGuard } from "./scoped-api-key.guard";

function contextFor(request: { headers: Record<string, string> }, scopes: string[] = []): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata("apiKeyScopes", scopes, handler);
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => class TestController {},
  } as unknown as ExecutionContext;
}

describe("ScopedApiKeyGuard", () => {
  const key = "test-api-key";
  const config = { get: jest.fn(() => JSON.stringify({ [key]: ["oracle:read"] })) } as unknown as ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("accepts a valid key with the required scope", () => {
    const guard = new ScopedApiKeyGuard(config, new Reflector());
    const context = contextFor({ headers: { "x-api-key": key } }, ["oracle:read"]);
    expect(guard.canActivate(context)).toBe(true);
  });

  it("rejects missing, invalid, and insufficiently scoped keys", () => {
    const guard = new ScopedApiKeyGuard(config, new Reflector());
    expect(() => guard.canActivate(contextFor({ headers: {} }))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(contextFor({ headers: { "x-api-key": "wrong" } }))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(contextFor({ headers: { "x-api-key": key } }, ["claims:write"]))).toThrow(ForbiddenException);
  });

  it("limits requests independently per API key", () => {
    const guard = new ScopedApiKeyGuard(config, new Reflector());
    const context = contextFor({ headers: { "x-api-key": key } });
    for (let index = 0; index < 60; index += 1) expect(guard.canActivate(context)).toBe(true);
    expect(() => guard.canActivate(context)).toThrow(TooManyRequestsException);
  });

  it("exposes the scope decorator for endpoint metadata", () => {
    const handler = () => undefined;
    RequireApiKeyScopes("oracle:read")(handler, "name", { value: handler });
    expect(Reflect.getMetadata("apiKeyScopes", handler)).toEqual(["oracle:read"]);
  });
});
