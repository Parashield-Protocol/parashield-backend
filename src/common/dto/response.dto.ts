import { ApiProperty } from '@nestjs/swagger';

/**
 * Base response envelope.
 * All API responses include `success` and either `data` or `error`.
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
    description: 'Response payload',
    required: false,
  })
  data?: T;

  @ApiProperty({
    description: 'Error description (only present on failure)',
    required: false,
    example: 'Invalid coverage amount',
  })
  error?: string;
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
