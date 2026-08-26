import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

// Guard against runaway recursion on deeply nested payloads; anything below
// this depth is left untouched.
const MAX_SANITIZATION_DEPTH = 10;

/**
 * InputSanitizationMiddleware (#380) — sanitizes user-provided strings in
 * JSON/urlencoded request bodies before they reach validation pipes, DTOs,
 * and persistence.
 *
 * For every string it:
 *  - trims leading/trailing whitespace
 *  - escapes `<` and `>` so markup/script tags cannot survive into stored
 *    values and reflected responses (XSS)
 *
 * Only angle brackets are escaped on purpose: values such as webhook URLs,
 * Stellar addresses, oracle keys, and HMAC secrets are reused server-side,
 * and full HTML-entity encoding (e.g. of `&` or quotes) would corrupt them.
 * Registered globally on the Express adapter in main.ts, right after the
 * body parsers, so every route is covered without route-pattern wildcards.
 *
 * Query params are not rewritten: Express 5 exposes `req.query` as a
 * read-only getter, and all user-provided string fields flow through DTOs
 * populated from the body.
 */
@Injectable()
export class InputSanitizationMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const body = req.body as unknown;
    if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) {
      req.body = sanitize(body) as typeof req.body;
    }
    next();
  }
}

function sanitize(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return sanitizeString(value);

  if (value !== null && typeof value === 'object' && depth < MAX_SANITIZATION_DEPTH) {
    if (Buffer.isBuffer(value)) return value;

    if (Array.isArray(value)) {
      return value.map((item) => sanitize(item, depth + 1));
    }

    const plain = Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
    if (!plain) return value; // Date, Map, class instances etc. are left alone

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = sanitize(item, depth + 1);
    }
    return result;
  }

  return value;
}

function sanitizeString(value: string): string {
  return value.trim().replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
