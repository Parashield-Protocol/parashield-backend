import { OpenAPIObject } from '@nestjs/swagger';

// #427 — Rate limit response headers injected into every operation so
// developers can see exactly what to expect from the global ThrottleGuard
// without reading source code.
const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit': {
    description:
      'Maximum number of requests allowed per rate limit window (60 requests per 60 seconds, per IP).',
    schema: { type: 'integer', example: 60 },
  },
  'X-RateLimit-Remaining': {
    description: 'Number of requests remaining in the current rate limit window.',
    schema: { type: 'integer', example: 42 },
  },
  'X-RateLimit-Reset': {
    description: 'Unix timestamp (seconds) at which the current rate limit window resets.',
    schema: { type: 'integer', example: 1735689600 },
  },
};

const RETRY_AFTER_HEADER = {
  'Retry-After': {
    description:
      'Seconds to wait before retrying. Present only on 429 responses, once the rate limit has been exceeded.',
    schema: { type: 'integer', example: 30 },
  },
};

// Standard 429 response object injected for every operation that does not
// already declare one. Gives developers a concrete example of the error
// envelope returned when the global rate limit is exceeded.
const RATE_LIMIT_429_RESPONSE = {
  description:
    'Too Many Requests — the global rate limit of 60 requests per 60-second window (per IP) ' +
    'has been exceeded. Wait for the number of seconds in the `Retry-After` header before retrying.',
  headers: {
    ...RATE_LIMIT_HEADERS,
    ...RETRY_AFTER_HEADER,
  },
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          success:    { type: 'boolean', example: false },
          errorCode:  { type: 'string',  example: 'TOO_MANY_REQUESTS' },
          error:      { type: 'string',  example: 'Too many requests. Please try again later.' },
          statusCode: { type: 'integer', example: 429 },
          retryAfter: { type: 'integer', example: 42, description: 'Seconds remaining until the window resets.' },
          path:       { type: 'string',  example: '/api/v1/policy' },
          timestamp:  { type: 'string',  format: 'date-time' },
        },
      },
    },
  },
};

/**
 * #427 — Post-process the generated OpenAPI document to surface rate limiting
 * rules directly in the Swagger UI.
 *
 * Two things are injected for every operation:
 *   1. X-RateLimit-* response headers on all existing responses (limit/remaining/reset).
 *   2. A 429 response entry if the operation does not already declare one, so
 *      developers see a concrete example of the error envelope and Retry-After
 *      header for every endpoint — without reading the guard source.
 *
 * ThrottleGuard (src/common/guards/throttle.guard.ts) enforces 60 req / 60 s
 * per IP and sets these headers at runtime.
 */
export function applyRateLimitHeaders(document: OpenAPIObject): void {
  for (const pathItem of Object.values(document.paths)) {
    for (const operation of Object.values(pathItem as Record<string, unknown>)) {
      const op = operation as { responses?: Record<string, { headers?: unknown }> };
      if (!op.responses) continue;

      // 1. Inject rate-limit headers into all declared responses.
      for (const [status, response] of Object.entries(op.responses)) {
        response.headers = {
          ...RATE_LIMIT_HEADERS,
          ...(status === '429' ? RETRY_AFTER_HEADER : {}),
          ...response.headers,
        };
      }

      // 2. Add a 429 response entry when the operation doesn't declare one,
      //    so every endpoint shows the rate limit error shape in the Swagger UI.
      if (!op.responses['429']) {
        op.responses['429'] = RATE_LIMIT_429_RESPONSE as unknown as { headers?: unknown };
      }
    }
  }
}
