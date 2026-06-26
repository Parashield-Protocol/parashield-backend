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

export class ConfirmPolicyDto {
  @ApiProperty({ description: 'Signed XDR transaction envelope from the wallet', example: 'AAAAAgAAAAA...' })
  @IsString()
  @IsNotEmpty()
  signedXdr: string;

  @ApiProperty({ description: 'Insurance product ID', example: '1' })
  @IsString()
  @IsNotEmpty()
  productId: string;

  @ApiProperty({ description: 'Coverage amount in XLM', example: 500 })
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

  @ApiProperty({ description: 'Policy duration in days', example: 90 })
  @IsInt()
  @Min(1)
  @Max(365)
  duration: number;
}
