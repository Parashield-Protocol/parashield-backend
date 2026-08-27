import { ApiProperty } from '@nestjs/swagger';
import { ErrorCode } from '../errors/error-codes';

/**
 * Canonical error envelope returned by GlobalExceptionFilter for every
 * non-2xx response. Controllers should reference this class in their
 * @ApiResponse decorators so the Swagger UI shows the actual error shape
 * rather than a plain description string.
 *
 * All fields are stable across versions — frontend/backend integrators
 * should key off `errorCode`, not the human-readable `error` message.
 */
export class ErrorResponseDto {
  @ApiProperty({
    description: 'Always false for error responses.',
    example: false,
  })
  success: boolean;

  @ApiProperty({
    description:
      'Stable machine-readable error code. Key off this value in client code — ' +
      'the human-readable `error` field may change between API versions.',
    enum: ErrorCode,
    example: ErrorCode.NOT_FOUND,
  })
  errorCode: ErrorCode;

  @ApiProperty({
    description:
      'Human-readable error message or, for 400 validation failures, an object ' +
      'containing per-field constraint violations from class-validator.',
    oneOf: [
      { type: 'string', example: 'Policy not found' },
      {
        type: 'object',
        properties: {
          message: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
          error: { type: 'string', example: 'Bad Request' },
          statusCode: { type: 'integer', example: 400 },
        },
      },
    ],
  })
  error: string | object;

  @ApiProperty({
    description: 'HTTP status code mirrored in the body for convenience.',
    example: 404,
  })
  statusCode: number;

  @ApiProperty({
    description: 'The request path that produced the error.',
    example: '/api/v1/policies/abc123',
  })
  path: string;

  @ApiProperty({
    description: 'ISO-8601 UTC timestamp at which the error occurred.',
    example: '2024-01-15T10:30:00.000Z',
  })
  timestamp: string;

  @ApiProperty({
    description:
      'Seconds to wait before retrying. Present **only** on 429 responses ' +
      'once the rate limit window has been exceeded.',
    example: 42,
    required: false,
  })
  retryAfter?: number;
}

// ---------------------------------------------------------------------------
// Per-errorCode example payloads used by the decorator helpers below.
// These are concrete examples the Swagger UI can render, one per error code.
// ---------------------------------------------------------------------------

function errorExample(
  errorCode: ErrorCode,
  statusCode: number,
  message: string,
  path = '/api/v1/resource',
  retryAfter?: number,
) {
  return {
    success: false,
    errorCode,
    error: message,
    statusCode,
    path,
    timestamp: '2024-01-15T10:30:00.000Z',
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  };
}

export const ERROR_EXAMPLES = {
  400: errorExample(ErrorCode.VALIDATION_ERROR, 400, 'wallet must be a string; productId should not be empty'),
  400_bad: errorExample(ErrorCode.BAD_REQUEST, 400, 'Malformed request parameter'),
  401: errorExample(ErrorCode.UNAUTHORIZED, 401, 'Missing or invalid JWT — include Authorization: Bearer <token>'),
  403: errorExample(ErrorCode.FORBIDDEN, 403, 'Policy belongs to a different wallet'),
  404: errorExample(ErrorCode.NOT_FOUND, 404, 'Resource not found'),
  409: errorExample(ErrorCode.CONFLICT, 409, 'An active claim already exists for this policy'),
  410: errorExample(ErrorCode.GONE, 410, 'Policy has expired and is no longer accessible'),
  429: errorExample(ErrorCode.TOO_MANY_REQUESTS, 429, 'Too many requests. Please try again later.', '/api/v1/resource', 42),
  500: errorExample(ErrorCode.INTERNAL_ERROR, 500, 'An unexpected error occurred'),
  503: errorExample(ErrorCode.SERVICE_UNAVAILABLE, 503, 'A downstream dependency is currently unavailable'),
};
