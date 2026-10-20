import { IsInt, IsOptional, IsString, Min } from 'class-validator';
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

  @ApiPropertyOptional({ description: 'New policy start timestamp (Unix seconds)', example: 1780272000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  startTime?: number;

  @ApiPropertyOptional({ description: 'New policy end timestamp (Unix seconds)', example: 1782864000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  endTime?: number;
}
