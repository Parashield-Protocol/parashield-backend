import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * #713 — API version discovery.
 *
 * Every response carries an `X-API-Version` header so clients can tell which
 * version of the API served their request without parsing the URL. The value is
 * the semantic version advertised for the matched route segment (`v1` →
 * `1.0.0`, `v2` → `2.0.0`).
 *
 * This module is the single source of truth for version resolution, shared by
 * the interceptor (success paths), the global exception filter (error paths)
 * and an early middleware (responses that never reach either, e.g. CORS
 * preflights).
 */

export const API_VERSION_HEADER = 'X-API-Version';

/** Route-segment version → advertised semantic version. */
export const API_VERSIONS: Record<string, string> = {
  v1: '1.0.0',
  v2: '2.0.0',
};

/** Version used when the request does not name one. */
export const DEFAULT_API_VERSION = 'v1';

/** Route-segment versions the API currently supports. */
export const SUPPORTED_API_VERSIONS = Object.keys(API_VERSIONS);

/** `true` when `version` (e.g. `v1`) is a supported route segment. */
export function isSupportedVersion(version: string): boolean {
  return Object.prototype.hasOwnProperty.call(API_VERSIONS, version);
}

/** Advertised semantic version for a route segment, or `undefined` if unknown. */
export function apiVersionHeaderValue(version: string): string | undefined {
  return isSupportedVersion(version) ? API_VERSIONS[version] : undefined;
}

/** Strip the query string and fragment from a URL/path. */
function pathnameOf(pathOrUrl: string): string {
  const withoutHash = pathOrUrl.split('#', 1)[0];
  return withoutHash.split('?', 1)[0];
}

/** Pull the `vN` segment out of a path such as `/api/v1/policies`. */
export function versionSegmentFromPath(pathOrUrl?: string): string | undefined {
  if (!pathOrUrl) return undefined;
  const match = /^\/api\/(v\d+)(?:[\/?#]|$)/.exec(pathnameOf(pathOrUrl));
  return match?.[1];
}

/**
 * Normalise a request `x-api-version` value into a route-segment version.
 * Accepts `v1`, `1`, `1.0` and `1.0.0` (case-insensitive).
 */
export function normalizeVersionToken(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (isSupportedVersion(trimmed.toLowerCase())) {
    return trimmed.toLowerCase();
  }

  if (/^\d+(?:\.\d+)*$/.test(trimmed)) {
    const major = trimmed.split('.')[0];
    const candidate = `v${major}`;
    if (isSupportedVersion(candidate)) {
      // Accept a bare major version ("1"), the advertised version ("1.0.0"), or
      // a prefix of it ("1.0").
      const advertised = API_VERSIONS[candidate];
      if (trimmed === major || trimmed === advertised || advertised.startsWith(`${trimmed}.`)) {
        return candidate;
      }
    }
  }

  return undefined;
}

/**
 * Resolve the version for a request: the path segment wins (it is what routing
 * uses), then an explicit `x-api-version` header, then the default.
 */
export function resolveRequestedVersion(
  pathOrUrl?: string,
  headerValue?: string,
): string {
  return (
    versionSegmentFromPath(pathOrUrl) ??
    normalizeVersionToken(headerValue) ??
    DEFAULT_API_VERSION
  );
}

/** Minimal response surface needed to set version headers. */
export interface VersionHeaderTarget {
  setHeader?(name: string, value: string): unknown;
  headersSent?: boolean;
}

/**
 * Set `X-API-Version` (and, for `v1`, the deprecation headers) on a response if
 * it is still writable. No-op when the version is unknown or the headers have
 * already been flushed, so it is safe to call from any layer.
 */
export function applyApiVersionHeaders(
  response: VersionHeaderTarget | undefined,
  version: string,
): void {
  if (!response || typeof response.setHeader !== 'function') return;
  if (response.headersSent) return;

  const value = apiVersionHeaderValue(version);
  if (!value) return;

  response.setHeader(API_VERSION_HEADER, value);

  if (version === DEFAULT_API_VERSION) {
    response.setHeader('Deprecation', 'true');
    response.setHeader('Link', '</api/v2>; rel="successor"');
  }
}

/**
 * Early middleware that stamps `X-API-Version` on every response, including
 * ones produced before or outside the Nest interceptor/filter pipeline.
 */
export function createApiVersionMiddleware(): RequestHandler {
  return function apiVersionHeader(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const header = req.headers?.['x-api-version'];
    const version = resolveRequestedVersion(
      req.originalUrl || req.url,
      Array.isArray(header) ? header[0] : header,
    );
    applyApiVersionHeaders(res, version);
    next();
  };
}
