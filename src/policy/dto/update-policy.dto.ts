import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for updating policy properties (#717).
 */
export class UpdatePolicyDto {
  @ApiPropertyOptional({
    description: 'New oracle key to monitor for this policy (e.g. rainfall:lat,lng:YYYY-MM or flight:flightNumber:YYYY-MM-DD)',
    example: 'rainfall:-0.0917,34.7679:2026-07',
  })
  @IsOptional()
  @IsString()
  oracleKey?: string;
}
