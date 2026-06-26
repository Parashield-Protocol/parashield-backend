import { IsNumber, IsInt, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class OracleFeedRequestDto {
  @ApiProperty({
    description: 'Latitude coordinate',
    example: -0.0917,
  })
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat: number;

  @ApiProperty({
    description: 'Longitude coordinate',
    example: 34.7679,
  })
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng: number;

  @ApiProperty({
    description: 'Year (e.g. 2026)',
    example: 2026,
  })
  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;

  @ApiProperty({
    description: 'Month (1–12)',
    minimum: 1,
    maximum: 12,
    example: 6,
  })
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;
}

export class OracleReadingResponseDto {
  @ApiProperty({ description: 'Data type (weather, flight, defi)' })
  dataType: string;

  @ApiProperty({ description: 'Oracle data key used to look up readings' })
  key: string;

  @ApiProperty({
    description: 'Reading value in 7-decimal fixed point (as string to preserve precision)',
    example: '324000000',
  })
  value: string;

  @ApiProperty({ description: 'Confidence score 0–100' })
  confidence: number;

  @ApiProperty({ description: 'Unix timestamp of when data was fetched' })
  timestamp: number;

  @ApiProperty({ description: 'Data source identifier (open-meteo, aviationstack, mock)' })
  source: string;
}
