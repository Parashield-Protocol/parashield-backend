import { ApiProperty } from '@nestjs/swagger';

/**
 * Base response envelope.
 *
 * All API responses follow this shape:
 *   - success responses: `{ success: true, data: T }`
 *   - error responses:   `{ success: false, errorCode, error, statusCode, path, timestamp }`
 *
 * `errorCode` is a stable machine-readable string (see ErrorCode enum in
 * src/common/errors/error-codes.ts) so clients can branch without parsing
 * human-readable messages. The `error` field is always a plain string —
 * never a nested object (#425).
 *
 * This class is used in @ApiResponse decorators so the OpenAPI schema
 * includes the `success` field — fixing SDK generation (#134).
 */
export class ResponseDto<T = unknown> {
  @ApiProperty({
    description: 'Whether the request succeeded',
    example: true,
  })
  success: boolean;

  @ApiProperty({
    description: 'Response payload (present on success)',
    required: false,
  })
  data?: T;

  @ApiProperty({
    description: 'Human-readable error description (present on failure, always a plain string)',
    required: false,
    example: 'Invalid coverage amount',
  })
  error?: string;

  @ApiProperty({
    description: 'Stable machine-readable error code (present on failure). See ErrorCode enum.',
    required: false,
    example: 'VALIDATION_ERROR',
  })
  errorCode?: string;

  @ApiProperty({
    description: 'HTTP status code (present on failure)',
    required: false,
    example: 400,
  })
  statusCode?: number;

  @ApiProperty({
    description: 'Request path (present on failure)',
    required: false,
    example: '/api/v1/policy',
  })
  path?: string;

  @ApiProperty({
    description: 'ISO-8601 timestamp of the error (present on failure)',
    required: false,
    example: '2026-01-01T00:00:00.000Z',
  })
  timestamp?: string;

  @ApiProperty({
    description: 'Seconds to wait before retrying (present on 429 responses only)',
    required: false,
    example: 42,
  })
  retryAfter?: number;
}

/**
 * Paginated response envelope for list endpoints.
 * Wraps `data` array with pagination metadata (#133).
 */
export class PaginatedResponseDto<T = unknown> {
  @ApiProperty({ description: 'Whether the request succeeded', example: true })
  success: boolean;

  @ApiProperty({
    description: 'Array of items for the current page',
    isArray: true,
  })
  data: T[];

  @ApiProperty({ description: 'Total number of items across all pages', example: 42 })
  total: number;

  @ApiProperty({ description: 'Current page number (1-based)', example: 1 })
  page: number;

  @ApiProperty({ description: 'Number of items per page', example: 20 })
  limit: number;
}
