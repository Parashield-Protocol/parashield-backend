import { ApiProperty } from '@nestjs/swagger';

export class PolicyStatusEventDto {
  @ApiProperty({ description: 'Policy UUID', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  policyId: string;

  @ApiProperty({
    description: 'Current policy status',
    example: 'ACTIVE',
    enum: ['ACTIVE', 'EXPIRED', 'CANCELLED', 'CLAIMED', 'PROCESSING'],
  })
  status: string;

  @ApiProperty({ description: 'Unix timestamp in milliseconds', example: 1700000000000 })
  timestamp: number;
}
