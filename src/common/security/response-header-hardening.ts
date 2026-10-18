import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { HelmetOptions } from 'helmet';
import helmet from 'helmet';

/** Minimal surface needed from an Express/Nest HTTP application. */
export interface SecurityHeaderApp {
  use(...args: unknown[]): unknown;
  /** Present on Express/NestExpressApplication; absent on some adapters. */
  disable?(setting: string): unknown;
}

/**
 * #711 — Response header hardening.
 *
 * Two classes of header leak implementation details and give attackers an easy
 * target list:
 *  - `X-Powered-By: Express` is set by Express itself.
 *  - `Server` (and friends such as `X-AspNet-Version`, `X-Runtime`, `Via`) are
 *    set by reverse proxies / upstream stacks that sit in front of the API.
 *
 * We strip them from every response. Stripping is done at the header level (by
 * wrapping `res.setHeader` / `res.writeHead`) so it also covers headers added
 * after this middleware runs, by the framework or any downstream middleware.
 */
export const LEAKY_RESPONSE_HEADERS: readonly string[] = [
  'Server',
  'X-Powered-By',
  'X-AspNet-Version',
  'X-AspNetMvc-Version',
  'X-Runtime',
  'Via',
];

/**
 * Express middleware that drops any response header whose (case-insensitive)
 * name is in `denylist`. Safe to apply more than once; each layer simply
 * filters the set of headers that reach the socket.
 */
export function createHeaderStrippingMiddleware(
  denylist: readonly string[] = LEAKY_RESPONSE_HEADERS,
): RequestHandler {
  const denied = new Set(denylist.map((name) => name.toLowerCase()));

  return function stripLeakyResponseHeaders(_req: Request, res: Response, next: NextFunction): void {
    const originalSetHeader = res.setHeader.bind(res);
    const originalWriteHead = res.writeHead.bind(res);

    res.setHeader = function patchedSetHeader(
      this: Response,
      name: string,
      value: number | string | readonly string[],
    ): Response {
      if (denied.has(String(name).toLowerCase())) {
        return this;
      }
      originalSetHeader(name, value);
      return this;
    } as unknown as typeof res.setHeader;

    // `writeHead(status, headers)` can be called directly with a header bag,
    // bypassing `setHeader`; filter that bag too.
    res.writeHead = function patchedWriteHead(this: Response, ...args: unknown[]): Response {
      const headersIndex = args.findIndex(
        (arg) => arg !== null && typeof arg === 'object' && !Array.isArray(arg),
      );
      if (headersIndex !== -1) {
        const headers = { ...(args[headersIndex] as Record<string, unknown>) };
        for (const key of Object.keys(headers)) {
          if (denied.has(key.toLowerCase())) delete headers[key];
        }
        args[headersIndex] = headers;
      }
      return (originalWriteHead as (...innerArgs: unknown[]) => Response).apply(this, args);
    } as unknown as typeof res.writeHead;

    // Headers already set (e.g. by an upstream layer before this runs) must go.
    const existing = typeof res.getHeaderNames === 'function' ? res.getHeaderNames() : [];
    for (const name of existing) {
      if (denied.has(name.toLowerCase())) {
        res.removeHeader(name);
      }
    }

    next();
  };
}

export interface SecurityHeaderOptions {
  /** Extra header names to strip, in addition to {@link LEAKY_RESPONSE_HEADERS}. */
  extraHeadersToStrip?: readonly string[];
  /** Helmet options; merged over the secure defaults. */
  helmetOptions?: HelmetOptions;
}

/**
 * Apply the full response-header hardening stack to an Express/Nest application:
 *  1. disable Express's `X-Powered-By` at the framework level (cheapest, so it
 *     is never even generated);
 *  2. install helmet for the standard security headers (with `hidePoweredBy`
 *     on as a second line of defence);
 *  3. strip the remaining leaky headers from every response.
 *
 * Returns the header-stripping middleware so callers (and tests) can inspect or
 * reuse it.
 */
export function applySecurityHeaders(
  app: SecurityHeaderApp,
  options: SecurityHeaderOptions = {},
): RequestHandler {
  // 1. Express-level (also mirrors helmet's hidePoweredBy behaviour).
  if (typeof app.disable === 'function') {
    app.disable('x-powered-by');
  }

  // 2. Standard security headers.
  app.use(
    helmet({
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
      ...options.helmetOptions,
      // Hard-code this on regardless of caller options: leaking the stack is
      // the thing this module exists to prevent.
      hidePoweredBy: true,
    }),
  );

  // 3. Strip leftover leaky headers.
  const denylist = [
    ...LEAKY_RESPONSE_HEADERS,
    ...(options.extraHeadersToStrip ?? []),
  ];
  const strip = createHeaderStrippingMiddleware(denylist);
  app.use(strip);
  return strip;
}
