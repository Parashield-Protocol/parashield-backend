import { ApiProperty } from '@nestjs/swagger';

export class ProductResponseDto {
  @ApiProperty({ description: 'Product unique identifier' })
  id: string;

  @ApiProperty({ description: 'Product name' })
  name: string;

  @ApiProperty({ description: 'Insurance category (crop, flight, defi)' })
  category: string;

  @ApiProperty({ description: 'Oracle trigger type (Threshold, Range)' })
  triggerType: string;

  @ApiProperty({ description: 'Trigger threshold in 7-decimal fixed point' })
  threshold: string;

  @ApiProperty({ description: 'Premium rate in basis points (500 = 5%)' })
  premiumRate: number;

  @ApiProperty({ description: 'Maximum policy duration in days' })
  maxDuration: number;

  @ApiProperty({ description: 'Product status (Active, Inactive, Deprecated)' })
  status: string;
}

export class PolicyResponseDto {
  @ApiProperty({ description: 'Policy unique identifier (UUID)' })
  id: string;

  @ApiProperty({ description: 'Associated product ID' })
  productId: string;

  @ApiProperty({ description: 'Policyholder Stellar wallet address' })
  policyholder: string;

  @ApiProperty({ description: 'Coverage amount in XLM (7-decimal fixed point)' })
  coverageXlm: string;

  @ApiProperty({ description: 'Premium paid in XLM (7-decimal fixed point)' })
  premiumPaid: string;

  @ApiProperty({ description: 'Oracle data key used for trigger evaluation' })
  oracleKey: string;

  @ApiProperty({ description: 'Policy start timestamp (Unix seconds)' })
  startTime: number;

  @ApiProperty({ description: 'Policy end timestamp (Unix seconds)' })
  endTime: number;

  @ApiProperty({ description: 'Policy status (ACTIVE, EXPIRED, CANCELLED, CLAIMED)' })
  status: string;

  @ApiProperty({ description: 'Stellar transaction hash for policy creation', nullable: true })
  txHash: string | null;
}
