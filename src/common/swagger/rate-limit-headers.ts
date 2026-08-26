import { OpenAPIObject } from '@nestjs/swagger';

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

/**
 * ThrottleGuard (src/common/guards/throttle.guard.ts) is a global guard that
 * attaches X-RateLimit-* headers to every response, and Retry-After to 429s.
 * OpenAPI has no "applies to every operation" construct, so this walks the
 * generated document and injects them into every response after the fact.
 */
export function applyRateLimitHeaders(document: OpenAPIObject): void {
  for (const pathItem of Object.values(document.paths)) {
    for (const operation of Object.values(pathItem as Record<string, unknown>)) {
      const responses = (operation as { responses?: Record<string, { headers?: unknown }> })
        ?.responses;
      if (!responses) continue;

      for (const [status, response] of Object.entries(responses)) {
        response.headers = {
          ...RATE_LIMIT_HEADERS,
          ...(status === '429' ? RETRY_AFTER_HEADER : {}),
          ...response.headers,
        };
      }
    }
  }
}
