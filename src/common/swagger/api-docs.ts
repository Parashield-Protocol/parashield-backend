import { REALTIME_DOCS } from './realtime-docs';

export const API_DOCS = 'Decentralized parametric insurance protocol on Stellar Soroban\n\n' +
      '## Rate Limiting\n\n' +
      'All endpoints are protected by a rate limiter applied per client IP address. Most ' +
      'endpoints use the app-wide default below, but a few sensitive endpoints enforce a ' +
      'tighter, endpoint-specific window — check that endpoint\'s own 429 response ' +
      'description (below in this doc) for its exact limit and reset window.\n\n' +
      '| Parameter | Value |\n' +
      '|-----------|-------|\n' +
      '| Window    | 60 seconds (default) |\n' +
      '| Limit     | 60 requests per window (default) |\n' +
      '| Scope     | Per IP address (`X-Forwarded-For` is honoured only from proxies trusted via `TRUST_PROXY`) |\n\n' +
      '| Endpoint | Window | Limit |\n' +
      '|----------|--------|-------|\n' +
      '| `POST /auth/challenge`, `POST /auth/login` | 60 seconds | 10 requests |\n' +
      '| `POST /claims` | 60 seconds | 5 requests |\n' +
      '| All other endpoints | 60 seconds | 60 requests |\n\n' +
      '### Response headers\n\n' +
      'Every response includes the following headers so clients can track their current usage. ' +
      '`X-RateLimit-Limit` and `X-RateLimit-Reset` reflect the window of the specific endpoint ' +
      'called, not always the app-wide default:\n\n' +
      '| Header | Description |\n' +
      '|--------|-------------|\n' +
      '| `X-RateLimit-Limit` | Maximum requests allowed in the current window for this endpoint |\n' +
      '| `X-RateLimit-Remaining` | Requests remaining before the limit is hit |\n' +
      '| `X-RateLimit-Reset` | Unix timestamp (seconds) at which this endpoint\'s window resets |\n\n' +
      '### Exceeded limit — 429 Too Many Requests\n\n' +
      'When the limit is exceeded the API responds with HTTP **429** and an additional ' +
      '`Retry-After` header indicating how many seconds to wait before retrying.\n\n' +
      '```json\n' +
      '{\n' +
      '  "success": false,\n' +
      '  "errorCode": "TOO_MANY_REQUESTS",\n' +
      '  "error": "Too many requests. Please try again later.",\n' +
      '  "statusCode": 429,\n' +
      '  "retryAfter": 42\n' +
      '}\n' +
      '```\n\n' +
      '## Request Timeouts\n\n' +
      'Every request is subject to a fixed processing timeout, enforced at two layers that share ' +
      'the same 30-second value:\n\n' +
      '| Layer | Behavior |\n' +
      '|-------|----------|\n' +
      '| Application middleware | Starts a timer when the request enters the handler chain. If no response has been sent after 30 seconds, it responds **408 Request Timeout** and closes the underlying connection so the server slot is freed immediately. |\n' +
      '| HTTP server socket | A 30-second idle timeout on the underlying Node HTTP server, as a fallback in case the application-level timer is bypassed. |\n\n' +
      'The timeout window is currently a fixed 30 seconds — it is not configurable via an environment ' +
      'variable — and applies uniformly to every route; there is no per-endpoint override.\n\n' +
      '### 408 response body\n\n' +
      'The 408 response is written directly by the timeout middleware before the request reaches ' +
      'route handling, so — unlike every other error response documented here — it does **not** use ' +
      'the standard error envelope (no `success`, `errorCode`, `path`, or `timestamp` fields):\n\n' +
      '```json\n' +
      '{\n' +
      '  "statusCode": 408,\n' +
      '  "error": "Request Timeout",\n' +
      '  "message": "The request exceeded the maximum allowed processing time."\n' +
      '}\n' +
      '```\n\n' +
      '### Handling 408s\n\n' +
      'A 408 means the handler was still running past the 30-second window, not that the request was ' +
      'necessarily rejected before doing any work. Treat it as retryable following the same guidance as ' +
      '`SERVICE_UNAVAILABLE` above (exponential backoff; for mutating `POST`/`PUT`/`PATCH` requests, ' +
      'resend the same `Idempotency-Key` so a request that actually completed server-side is not ' +
      're-executed).\n\n' +
      '## Pagination\n\n' +
      'List endpoints that return more than a handful of rows accept `page` and `limit` query ' +
      'parameters and return a paginated envelope instead of a bare array:\n\n' +
      '| Parameter | Type | Default | Notes |\n' +
      '|-----------|------|---------|-------|\n' +
      '| `page`    | integer | `1`  | 1-based. Values below 1 are clamped up to 1. |\n' +
      '| `limit`   | integer | `20` | Clamped to the range `1`-`100`; values outside that range are clamped, not rejected. |\n\n' +
      '```json\n' +
      '{\n' +
      '  "success": true,\n' +
      '  "data": [ /* items for this page */ ],\n' +
      '  "total": 42,\n' +
      '  "page": 1,\n' +
      '  "limit": 20\n' +
      '}\n' +
      '```\n\n' +
      '| Field   | Description |\n' +
      '|---------|-------------|\n' +
      '| `data`  | Array of items for the requested page |\n' +
      '| `total` | Total number of items across all pages |\n' +
      '| `page`  | The page number this response corresponds to |\n' +
      '| `limit` | The page size this response used |\n\n' +
      'Paginated endpoints: `GET /products`, `GET /policies/me`, `GET /claims`, `GET /claims/history/{wallet}`. ' +
      'Some of these also support `?stream=true` (NDJSON, one item per line) as an alternative to the ' +
      'paginated JSON envelope for large result sets — see that endpoint\'s own `stream` parameter ' +
      'description for details; pagination metadata is then returned via the `X-Total-Count`, `X-Page`, ' +
      'and `X-Limit` response headers instead of the JSON body.\n\n' +
      '## Error Response Structure (RFC 7807 Problem Details)\n\n' +
      'All error responses are returned with `Content-Type: application/problem+json` conforming to ' +
      '[RFC 7807](https://datatracker.ietf.org/doc/html/rfc7807). Legacy envelope fields remain ' +
      'present for backward compatibility:\n\n' +
      '```json\n' +
      '{\n' +
      '  "type": "https://parashield.io/errors/not-found",\n' +
      '  "title": "Not Found",\n' +
      '  "status": 404,\n' +
      '  "detail": "Policy not found",\n' +
      '  "instance": "/api/v1/policies/abc123",\n' +
      '  "success": false,\n' +
      '  "errorCode": "NOT_FOUND",\n' +
      '  "error": "Policy not found",\n' +
      '  "message": "Policy not found",\n' +
      '  "statusCode": 404,\n' +
      '  "path": "/api/v1/policies/abc123",\n' +
      '  "timestamp": "2024-01-15T10:30:00.000Z"\n' +
      '}\n' +
      '```\n\n' +
      '### Standard RFC 7807 Members\n\n' +
      '| Member | Type | Description |\n' +
      '|---|---|---|\n' +
      '| `type` | `string (URI)` | Stable URI reference identifying the error type |\n' +
      '| `title` | `string` | Short human-readable summary of the problem type |\n' +
      '| `status` | `number` | HTTP status code |\n' +
      '| `detail` | `string` | Human-readable explanation specific to this occurrence |\n' +
      '| `instance` | `string (URI)` | Relative or absolute URI identifying the specific request path |\n' +
      '| `errors` | `array` | (Extension) Validation failure details from class-validator |\n' +
      '| `correlationId` | `string` | (Extension) Request correlation ID when available |\n\n' +
      '### Backward Compatibility Fields (Deprecated)\n\n' +
      '| Field | Type | Description |\n' +
      '|-------|------|-------------|\n' +
      '| `success` | `boolean` | Always `false` for errors (Deprecated: use `status`) |\n' +
      '| `errorCode` | `string` | Stable machine-readable code (Deprecated: use `type`) |\n' +
      '| `error` | `string` or `object` | Error message string (Deprecated: use `detail`) |\n' +
      '| `message` | `string` | Human-readable message (Deprecated: use `detail`) |\n' +
      '| `statusCode` | `number` | HTTP status code (Deprecated: use `status`) |\n' +
      '| `path` | `string` | Request path (Deprecated: use `instance`) |\n' +
      '| `timestamp` | `string` | ISO-8601 UTC timestamp |\n' +
      '| `retryAfter` | `number` | (Optional) Seconds to wait before retrying on 429 responses |\n\n' +

      '### Error Codes Reference\n\n' +
      '| `errorCode` | HTTP Status | When It Occurs |\n' +
      '|-------------|-------------|----------------|\n' +
      '| `VALIDATION_ERROR` | 400 | Request body fails validation rules (missing/invalid fields, wrong types). The `error` field contains validation details |\n' +
      '| `BAD_REQUEST` | 400 | Generic bad request not covered by validation (malformed path param, unsupported value, USDC precision errors) |\n' +
      '| `UNAUTHORIZED` | 401 | Missing or invalid JWT / wallet signature. Include `Authorization: Bearer <token>` or valid wallet headers |\n' +
      '| `FORBIDDEN` | 403 | Authenticated but not allowed (e.g. accessing another wallet\'s policy, calling operator-only endpoint without API key) |\n' +
      '| `NOT_FOUND` | 404 | Resource does not exist (policy ID, claim ID, oracle key, etc.) |\n' +
      '| `CONFLICT` | 409 | Duplicate resource (e.g. submitting a claim when one is already active for the same policy) |\n' +
      '| `GONE` | 410 | Resource existed but is no longer accessible (e.g. expired policy) |\n' +
      '| `TOO_MANY_REQUESTS` | 429 | Rate limit exceeded (60 requests per minute per IP). Back off and retry after the `retryAfter` value |\n' +
      '| `INTERNAL_ERROR` | 500 | Unexpected server failure. Logged server-side; response omits internal details |\n' +
      '| `SERVICE_UNAVAILABLE` | 503 | Downstream dependency unavailable (database, Redis, Stellar RPC) |\n\n' +
      '## Error Recovery\n\n' +
      'Guidance for programmatically recovering from each error, keyed off `errorCode` ' +
      '(not the human-readable `error` message, which may change between versions):\n\n' +
      '| `errorCode` | Retryable | Recommended recovery |\n' +
      '|-------------|-----------|----------------------|\n' +
      '| `VALIDATION_ERROR` | No | Fix the request body per the validation details in `error`, then resend |\n' +
      '| `BAD_REQUEST` | No | Correct the malformed field/value indicated in `error`, then resend |\n' +
      '| `UNAUTHORIZED` | No | Re-authenticate (refresh the JWT or re-sign the wallet challenge), then resend |\n' +
      '| `FORBIDDEN` | No | Not recoverable by retrying — the caller lacks permission for this resource/action |\n' +
      '| `NOT_FOUND` | No | Verify the ID/path is correct; do not retry against the same path |\n' +
      '| `CONFLICT` | No | Fetch current state first (e.g. existing claim) before deciding whether to resend |\n' +
      '| `GONE` | No | Resource is permanently inaccessible; stop retrying |\n' +
      '| `TOO_MANY_REQUESTS` | Yes | Wait `retryAfter` seconds (from the body) before retrying once |\n' +
      '| `INTERNAL_ERROR` | Yes | Retry with exponential backoff; escalate if it persists across retries |\n' +
      '| `SERVICE_UNAVAILABLE` | Yes | Retry with exponential backoff; check `/api/v1/health` to confirm dependency recovery |\n\n' +
      '### Retry strategy\n\n' +
      'For the retryable errors above (`TOO_MANY_REQUESTS`, `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`):\n\n' +
      '1. Respect `retryAfter` / `Retry-After` when present instead of retrying immediately.\n' +
      '2. Otherwise back off exponentially (e.g. 1s, 2s, 4s, 8s) with jitter, capped at a small number of attempts.\n' +
      '3. For mutating requests (`POST`/`PUT`/`PATCH`), send the same `Idempotency-Key` header on every retry so a ' +
      'request that actually succeeded server-side but timed out on the client is not re-executed — the API replays ' +
      'the cached response (marked with `X-Idempotent-Replayed: true`) instead of processing it twice. Idempotency ' +
      'keys are cached for 24 hours.\n' +
      '4. Give up and surface the error to the caller once retries are exhausted; non-retryable errors ' +
      '(`VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `GONE`, `BAD_REQUEST`) should ' +
      'never be retried unmodified — they will fail identically every time.\n\n' +
      '### Validation Errors (400)\n\n' +
      'When class-validator rejects a request body, the `error` field contains detailed constraint violations:\n\n' +
      '```json\n' +
      '{\n' +
      '  "success": false,\n' +
      '  "errorCode": "VALIDATION_ERROR",\n' +
      '  "error": {\n' +
      '    "message": ["wallet must be a string", "productId should not be empty"],\n' +
      '    "error": "Bad Request",\n' +
      '    "statusCode": 400\n' +
      '  },\n' +
      '  "statusCode": 400,\n' +
      '  "path": "/api/v1/policies/buy",\n' +
      '  "timestamp": "2024-01-15T10:30:00.000Z"\n' +
      '}\n' +
      '```\n\n' +
      '### USDC Precision Validation\n\n' +
      'All monetary amounts must conform to Stellar USDC precision (7 decimal places maximum). ' +
      'Requests with excessive precision are rejected with `BAD_REQUEST`:\n\n' +
      '```json\n' +
      '{\n' +
      '  "success": false,\n' +
      '  "errorCode": "BAD_REQUEST",\n' +
      '  "error": "Amount precision at amount exceeds Stellar USDC limit. Maximum 7 decimal places allowed, found 8. Value: \\"10.12345678\\"",\n' +
      '  "statusCode": 400,\n' +
      '  "path": "/api/v1/policies/buy",\n' +
      '  "timestamp": "2024-01-15T10:30:00.000Z"\n' +
      '}\n' +
      '```' +
      REALTIME_DOCS;
