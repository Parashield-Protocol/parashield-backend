/**
 * Structured error codes for all API error responses (#402).
 *
 * Frontend consumers should key off `errorCode` rather than parsing
 * the human-readable `error` message string, which may change across
 * versions. New codes should be added here and never removed (only
 * deprecated) to preserve backward compatibility.
 */
export enum ErrorCode {
  // ── Generic ──────────────────────────────────────────────────────────────
  INTERNAL_ERROR        = 'INTERNAL_ERROR',
  VALIDATION_ERROR      = 'VALIDATION_ERROR',
  NOT_FOUND             = 'NOT_FOUND',

  // ── Auth ─────────────────────────────────────────────────────────────────
  UNAUTHORIZED          = 'UNAUTHORIZED',
  FORBIDDEN             = 'FORBIDDEN',

  // ── Request / resource conflicts ─────────────────────────────────────────
  BAD_REQUEST           = 'BAD_REQUEST',
  CONFLICT              = 'CONFLICT',
  GONE                  = 'GONE',

  // ── Rate limiting ─────────────────────────────────────────────────────────
  TOO_MANY_REQUESTS     = 'TOO_MANY_REQUESTS',

  // ── Service availability ──────────────────────────────────────────────────
  SERVICE_UNAVAILABLE   = 'SERVICE_UNAVAILABLE',
}

/** Maps an HTTP status code to its canonical ErrorCode. */
export function errorCodeFromStatus(status: number): ErrorCode {
  switch (status) {
    case 400: return ErrorCode.VALIDATION_ERROR;
    case 401: return ErrorCode.UNAUTHORIZED;
    case 403: return ErrorCode.FORBIDDEN;
    case 404: return ErrorCode.NOT_FOUND;
    case 409: return ErrorCode.CONFLICT;
    case 410: return ErrorCode.GONE;
    case 429: return ErrorCode.TOO_MANY_REQUESTS;
    case 503: return ErrorCode.SERVICE_UNAVAILABLE;
    default:
      return status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.BAD_REQUEST;
  }
}
