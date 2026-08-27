import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { ErrorResponseDto, ERROR_EXAMPLES } from './error-response.dto';
import { ErrorCode } from '../errors/error-codes';

/**
 * Builds a single @ApiResponse decorator entry that references the shared
 * ErrorResponseDto schema and injects a concrete example for the given
 * HTTP status code.
 *
 * Usage — replace bare @ApiResponse({ status: 404, description: '...' }) with:
 *   @ApiErrorResponse(404, 'Policy not found')
 */
export function ApiErrorResponse(
  status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 500 | 503,
  description: string,
  errorCode?: ErrorCode,
  exampleMessage?: string,
) {
  // Pick the closest canned example, override the errorCode/message if supplied.
  const baseExample =
    status === 400
      ? { ...ERROR_EXAMPLES[400] }
      : status === 429
        ? { ...ERROR_EXAMPLES[429] }
        : status === 500
          ? { ...ERROR_EXAMPLES[500] }
          : status === 503
            ? { ...ERROR_EXAMPLES[503] }
            : { ...ERROR_EXAMPLES[status as keyof typeof ERROR_EXAMPLES] };

  if (errorCode)      baseExample.errorCode = errorCode;
  if (exampleMessage) baseExample.error     = exampleMessage;

  return applyDecorators(
    ApiExtraModels(ErrorResponseDto),
    ApiResponse({
      status,
      description,
      schema: {
        allOf: [{ $ref: getSchemaPath(ErrorResponseDto) }],
        example: baseExample,
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Pre-built decorator bundles for common auth/resource-error combinations.
// Import the set that matches the endpoint's requirements.
// ---------------------------------------------------------------------------

/** 401 + 403 — for authenticated endpoints that also check ownership. */
export function ApiAuthErrors() {
  return applyDecorators(
    ApiExtraModels(ErrorResponseDto),
    ApiErrorResponse(401, 'Missing or invalid JWT. Include Authorization: Bearer <token>.'),
    ApiErrorResponse(403, 'Authenticated but not permitted (e.g. resource belongs to another wallet).'),
  );
}

/** 400 validation + 401 + 403 + 404 */
export function ApiCrudErrors() {
  return applyDecorators(
    ApiExtraModels(ErrorResponseDto),
    ApiErrorResponse(400, 'Request body failed validation. The `error` field contains per-field constraint details.'),
    ApiErrorResponse(401, 'Missing or invalid JWT.'),
    ApiErrorResponse(403, 'Insufficient permissions.'),
    ApiErrorResponse(404, 'Resource not found.'),
  );
}

/**
 * Standard operator/admin-only error set (401 via API key, 403 insufficient
 * privilege). Use on endpoints protected by OperatorAuthGuard.
 */
export function ApiOperatorErrors() {
  return applyDecorators(
    ApiExtraModels(ErrorResponseDto),
    ApiErrorResponse(
      401,
      'Missing or invalid operator API key. Include x-api-key or x-admin-api-key header.',
      ErrorCode.UNAUTHORIZED,
      'Missing or invalid operator API key',
    ),
    ApiErrorResponse(403, 'This endpoint is restricted to operators.'),
  );
}
