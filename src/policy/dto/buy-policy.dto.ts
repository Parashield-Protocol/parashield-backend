import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  Min,
  Max,
  IsInt,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class BuyPolicyDto {
  @ApiProperty({ description: 'Insurance product ID', example: '1' })
  @IsString()
  @IsNotEmpty()
  productId: string;

  @ApiProperty({
    description: 'Coverage amount in XLM. Note: Product-specific coverage limits are additionally enforced at the service level.',
    minimum: 10,
    maximum: 100000,
    example: 500,
  })
  @IsNumber()
  @IsPositive()
  @Min(10)
  @Max(100000)
  coverageXlm: number;

  @ApiProperty({
    description: 'Stellar wallet address (G...)',
    example: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ',
  })
  @IsString()
  @Matches(/^G[A-Z2-7]{55}$/, {
    message: 'walletAddress must be a valid Stellar public key starting with G',
  })
  walletAddress: string;

  @ApiProperty({
    description: 'Policy duration in days',
    minimum: 1,
    maximum: 365,
    example: 90,
  })
  @IsInt()
  @Min(1)
  @Max(365)
  duration: number;

  @ApiProperty({
    description: 'Oracle data key for trigger evaluation',
    example: 'rainfall:-0.0917,34.7679:2026-06',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^(rainfall:-?\d+(\.\d+)?,-?\d+(\.\d+)?:20\d{2}-(0[1-9]|1[0-2])|flight:[A-Z0-9]+:20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])|defi:[a-zA-Z0-9_:-]+)$/, {
    message: 'oracleKey must match product category format (rainfall:lat,lng:YYYY-MM, flight:flightNumber:YYYY-MM-DD, or defi:key)',
  })
  oracleKey: string;
}
