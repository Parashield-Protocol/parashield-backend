import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ClaimsService } from './claims.service';
import { IsString, IsNotEmpty } from 'class-validator';

class SubmitClaimDto {
  @IsString() @IsNotEmpty() claimant: string;
  @IsString() @IsNotEmpty() policyId: string;
}

@Controller('claims')
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  /** POST /api/v1/claims — submit a manual claim */
  @Post()
  async submitClaim(@Body() dto: SubmitClaimDto) {
    const claimId = await this.claims.submitClaim(dto.claimant, dto.policyId);
    return { success: true, data: { claimId } };
  }

  /** POST /api/v1/claims/:policyId/auto — keeper triggers auto-processing */
  @Post(':policyId/auto')
  async autoProcess(@Param('policyId') policyId: string) {
    const result = await this.claims.autoProcess(policyId);
    return { success: true, data: { result } };
  }

  /** GET /api/v1/claims/:id — get claim status */
  @Get(':id')
  async getClaim(@Param('id') id: string) {
    const claim = await this.claims.getClaim(id);
    if (!claim) return { success: false, error: 'Claim not found' };
    return { success: true, data: claim };
  }
}
