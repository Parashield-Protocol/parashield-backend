import { ErrorCode, errorCodeFromStatus } from './error-codes';

/**
 * RFC 7807 Problem Details representation (#677).
 *
 * Conforms to RFC 7807 "Problem Details for HTTP APIs" served with Content-Type
 * `application/problem+json`. Backward compatibility is preserved by including
 * legacy fields (success, statusCode, error, message, errorCode, path, timestamp)
 * alongside the standard RFC 7807 members.
 */
export interface ProblemDetails {
  // ── Standard RFC 7807 members ──────────────────────────────────────────────
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;

  // ── Extension members ──────────────────────────────────────────────────────
  errors?: unknown;
  correlationId?: string;

  // ── Legacy fields (Deprecated: use RFC 7807 members) ────────────────────────
  success: false;
  statusCode: number;
  message: string;
  error: string | object;
  errorCode?: string;
  path?: string;
  timestamp: string;
  retryAfter?: number;
  [key: string]: unknown;
}

export interface BuildProblemDetailsOptions {
  status: number;
  message?: string;
  error?: string | object;
  errorCode?: string;
  path?: string;
  errors?: unknown;
  correlationId?: string;
  retryAfter?: number;
}

/**
 * Returns a stable URI reference identifying the problem type per RFC 7807.
 */
export function getProblemType(status: number, errorCode?: string): string {
  if (errorCode) {
    const slug = errorCode.toLowerCase().replace(/_/g, '-');
    return `https://parashield.io/errors/${slug}`;
  }

  switch (status) {
    case 400: return 'https://parashield.io/errors/bad-request';
    case 401: return 'https://parashield.io/errors/unauthorized';
    case 403: return 'https://parashield.io/errors/forbidden';
    case 404: return 'https://parashield.io/errors/not-found';
    case 408: return 'https://parashield.io/errors/request-timeout';
    case 409: return 'https://parashield.io/errors/conflict';
    case 410: return 'https://parashield.io/errors/gone';
    case 422: return 'https://parashield.io/errors/unprocessable-entity';
    case 429: return 'https://parashield.io/errors/too-many-requests';
    case 500: return 'https://parashield.io/errors/internal-error';
    case 502: return 'https://parashield.io/errors/bad-gateway';
    case 503: return 'https://parashield.io/errors/service-unavailable';
    case 504: return 'https://parashield.io/errors/gateway-timeout';
    default:
      return 'about:blank';
  }
}

/**
 * Returns a short, human-readable summary of the problem type per RFC 7807.
 */
export function getProblemTitle(status: number): string {
  switch (status) {
    case 400: return 'Bad Request';
    case 401: return 'Unauthorized';
    case 403: return 'Forbidden';
    case 404: return 'Not Found';
    case 408: return 'Request Timeout';
    case 409: return 'Conflict';
    case 410: return 'Gone';
    case 422: return 'Unprocessable Entity';
    case 429: return 'Too Many Requests';
    case 500: return 'Internal Server Error';
    case 502: return 'Bad Gateway';
    case 503: return 'Service Unavailable';
    case 504: return 'Gateway Timeout';
    default:
      return status >= 500 ? 'Internal Server Error' : 'Error';
  }
}

/**
 * Constructs an RFC 7807 Problem Details object with backward compatibility fields.
 *
 * Security: 500 errors are sanitized to generic text; stack traces, internal SQL,
 * and system secrets are never leaked into `detail`.
 */
export function buildProblemDetails(options: BuildProblemDetailsOptions): ProblemDetails {
  const {
    status,
    message,
    error,
    errorCode,
    path,
    errors,
    correlationId,
    retryAfter,
  } = options;

  const type = getProblemType(status, errorCode);
  const title = getProblemTitle(status);

  // Security guard: never leak internal exception details for 5xx errors
  const safeDetail = status >= 500
    ? 'An unexpected error occurred. Please try again later.'
    : (message || (typeof error === 'string' ? error : title));

  const safeLegacyError = status >= 500
    ? 'Internal server error'
    : (error ?? safeDetail);

  const problem: ProblemDetails = {
    // RFC 7807 standard members
    type,
    title,
    status,
    detail: safeDetail,
    instance: path,

    // Backward compatibility fields (deprecated)
    success: false,
    statusCode: status,
    message: safeDetail,
    error: safeLegacyError,
    errorCode: errorCode ?? errorCodeFromStatus(status),
    path,
    timestamp: new Date().toISOString(),
  };

  if (errors !== undefined) {
    problem.errors = errors;
  }

  if (correlationId) {
    problem.correlationId = correlationId;
  }

  if (retryAfter !== undefined) {
    problem.retryAfter = retryAfter;
  }

  return problem;
}
