import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
  IsNumber,
  IsInt,
  IsString,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Validates that a numeric property is finite, explicitly rejecting NaN and +/-Infinity (#752).
 */
export function IsFiniteNumber(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      name: 'isFiniteNumber',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any) {
          return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a finite number (NaN and Infinity are not allowed)`;
        },
      },
    });
  };
}

export class OracleFeedRequestDto {
  @ApiProperty({
    description: 'Latitude coordinate',
    example: -0.0917,
  })
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'lat must be a finite number' })
  @IsFiniteNumber({ message: 'lat must be a finite number (NaN and Infinity are not allowed)' })
  @Min(-90)
  @Max(90)
  lat: number;

  @ApiProperty({
    description: 'Longitude coordinate',
    example: 34.7679,
  })
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'lng must be a finite number' })
  @IsFiniteNumber({ message: 'lng must be a finite number (NaN and Infinity are not allowed)' })
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

export class OracleReadingDto {
  @ApiProperty({ description: 'Data type (weather, flight, defi)' })
  @IsString()
  dataType: string;

  @ApiProperty({ description: 'Oracle data key used to look up readings' })
  @IsString()
  key: string;

  @ApiProperty({
    description: 'Reading numeric value (must be a finite number)',
    example: 32.4,
  })
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'value must be a finite number' })
  @IsFiniteNumber({ message: 'value must be a finite number (NaN and Infinity are not allowed)' })
  value: number;

  @ApiProperty({ description: 'Confidence score 0–100' })
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'confidence must be a finite number' })
  @IsFiniteNumber({ message: 'confidence must be a finite number (NaN and Infinity are not allowed)' })
  @Min(0)
  @Max(100)
  confidence: number;

  @ApiProperty({ description: 'Unix timestamp of when data was fetched' })
  @IsInt()
  @Min(0)
  timestamp: number;

  @ApiProperty({ description: 'Data source identifier (open-meteo, aviationstack, mock)' })
  @IsString()
  source: string;
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

