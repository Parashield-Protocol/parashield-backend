import { IsString, IsUUID, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SubmitClaimDto {
  @ApiProperty({
    description: 'Stellar wallet address of the claimant',
    example: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ',
  })
  @IsString()
  @Matches(/^G[A-Z2-7]{55}$/, {
    message: 'walletAddress must be a valid Stellar public key starting with G',
  })
  walletAddress: string;

  @ApiProperty({
    description: 'UUID of the policy to claim against',
    example: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
  })
  @IsUUID()
  policyId: string;
}

export class ClaimResponseDto {
  @ApiProperty({ description: 'Claim unique identifier (UUID)' })
  id: string;

  @ApiProperty({ description: 'Associated policy ID' })
  policyId: string;

  @ApiProperty({ description: 'Claimant Stellar wallet address' })
  claimant: string;

  @ApiProperty({ description: 'Coverage amount to be paid (7-decimal fixed point string)' })
  coverageAmount: string;

  @ApiProperty({ description: 'Actual payout amount sent on-chain (7-decimal fixed point string)', nullable: true })
  payoutAmount: string | null;

  @ApiProperty({ description: 'Whether the insurance trigger condition was met' })
  triggerMet: boolean;

  @ApiProperty({ description: 'Claim status (PENDING, PROCESSING, PAID, REJECTED, EXPIRED)' })
  status: string;

  @ApiProperty({ description: 'Claim submission timestamp (Unix seconds)' })
  submittedAt: number;

  @ApiProperty({ description: 'Claim processing timestamp (Unix seconds)', nullable: true })
  processedAt: number | null;

  @ApiProperty({ description: 'Stellar transaction hash for payout', nullable: true })
  txHash: string | null;
}
