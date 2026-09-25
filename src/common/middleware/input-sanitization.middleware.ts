import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

// Guard against runaway recursion on deeply nested payloads; anything below
// this depth is left untouched.
const MAX_SANITIZATION_DEPTH = 10;

// Keys that can be used for prototype pollution; dropped from request bodies.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * InputSanitizationMiddleware (#380) — sanitizes user-provided strings in
 * JSON/urlencoded request bodies before they reach validation pipes, DTOs,
 * and persistence.
 *
 * For every string it:
 *  - trims leading/trailing whitespace
 *  - drops `__proto__`, `constructor` and `prototype` keys (#590)
 *  - escapes `<` and `>` so markup/script tags cannot survive into stored
 *    values and reflected responses (XSS)
 *  - escapes `"` and `'` (#581) so stored values cannot break out of quoted
 *    attribute or string contexts downstream
 *
 * `&` is left alone on purpose: values such as webhook URLs, Stellar
 * addresses, oracle keys, and HMAC secrets are reused server-side, and
 * escaping it would corrupt query strings.
 *
 * #485 — this middleware is still NOT a full output encoder. Stored strings
 * may still contain `&`, which is only safe inside JSON. The
 * API itself only ever responds with `application/json` (helmet sets
 * `X-Content-Type-Options: nosniff` so browsers won't sniff it as HTML), and
 * any consumer that interpolates these values into HTML — the frontend, an
 * email template, a server-rendered page — must encode them for that
 * context. Server-side code that builds HTML must use `escapeHtml()` below.
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
      if (FORBIDDEN_KEYS.has(key)) continue;
      result[key] = sanitize(item, depth + 1);
    }
    return result;
  }

  return value;
}

function sanitizeString(value: string): string {
  return value
    .trim()
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * #485 — context-appropriate output encoding for HTML text and quoted
 * attribute values. Encodes all five HTML-significant characters, so a value
 * like `x" onmouseover="alert(1)` cannot break out of an attribute.
 *
 * Apply this at render time, not on input: `&` is escaped first-class here,
 * so running it over a value the input sanitizer already touched turns
 * `&lt;` into `&amp;lt;`, which renders as the literal text `&lt;` rather
 * than markup — safe, just visibly double-encoded.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}
