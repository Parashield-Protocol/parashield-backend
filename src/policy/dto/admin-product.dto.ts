import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsInt,
  IsPositive,
  Min,
  IsIn,
  IsOptional,
} from 'class-validator';
import { ApiProperty, PartialType } from '@nestjs/swagger';

const CATEGORIES   = ['crop', 'flight', 'defi'];
const COMPARISONS  = ['gte', 'lte', 'eq'];
const STATUSES     = ['ACTIVE', 'INACTIVE', 'DEPRECATED'];

export class CreateProductDto {
  @ApiProperty({ description: 'Product name', example: 'Kisumu Rainfall Cover' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ description: 'Insurance category', enum: CATEGORIES })
  @IsString()
  @IsIn(CATEGORIES)
  category: string;

  @ApiProperty({ description: 'Oracle trigger type (Threshold, Range)', example: 'Threshold' })
  @IsString()
  @IsNotEmpty()
  triggerType: string;

  @ApiProperty({ description: 'Trigger threshold in 7-decimal fixed point', example: '50.0000000' })
  @IsNumber({ maxDecimalPlaces: 7 })
  threshold: number;

  @ApiProperty({ description: 'Comparison operator', enum: COMPARISONS })
  @IsString()
  @IsIn(COMPARISONS)
  comparison: string;

  @ApiProperty({ description: 'Minimum coverage amount (7-decimal fixed point)', example: 10 })
  @IsNumber({ maxDecimalPlaces: 7 })
  @IsPositive()
  coverageMin: number;

  @ApiProperty({ description: 'Maximum coverage amount (7-decimal fixed point)', example: 1000 })
  @IsNumber({ maxDecimalPlaces: 7 })
  @IsPositive()
  coverageMax: number;

  @ApiProperty({ description: 'Premium rate in basis points (500 = 5%)', example: 500 })
  @IsInt()
  @Min(1)
  premiumRate: number;

  @ApiProperty({ description: 'Maximum policy duration in days', example: 365 })
  @IsInt()
  @Min(1)
  maxDuration: number;

  @ApiProperty({ description: 'Product status', enum: STATUSES, required: false, default: 'ACTIVE' })
  @IsOptional()
  @IsString()
  @IsIn(STATUSES)
  status?: string;
}

export class UpdateProductDto extends PartialType(CreateProductDto) {}
