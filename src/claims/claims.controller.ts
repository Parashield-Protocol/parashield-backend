import { Body, Controller, Get, Param, Post, Req, UseGuards, UnauthorizedException } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { ClaimsService } from './claims.service';
import { SubmitClaimDto } from './dto/submit-claim.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Request } from 'express';

@ApiTags('claims')
@Controller('claims')
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  /** POST /api/v1/claims/submit — submit a manual claim */
  @Post('submit')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Submit a manual claim for a policy' })
  @ApiResponse({ status: 201, description: 'Claim submitted successfully' })
  @ApiResponse({ status: 409, description: 'Claim already exists for this policy' })
  async submitClaim(@Req() req: Request & { user?: any }, @Body() dto: SubmitClaimDto) {
    if (dto.walletAddress !== req.user?.walletAddress) {
      throw new UnauthorizedException('Wallet address does not match authenticated user');
    }
    const claimId = await this.claims.submitClaim(dto.walletAddress, dto.policyId);
    return { success: true, data: { claimId } };
  }

  /** POST /api/v1/claims/:policyId/auto — keeper triggers auto-processing */
  @Post(':policyId/auto')
  @ApiOperation({ summary: 'Trigger automatic claim evaluation for a policy' })
  @ApiParam({ name: 'policyId', description: 'Policy UUID to evaluate' })
  @ApiResponse({ status: 201, description: 'Claim evaluation triggered' })
  async autoProcess(@Param('policyId') policyId: string) {
    const result = await this.claims.autoProcess(policyId);
    return { success: true, data: { result } };
  }

  /** GET /api/v1/claims/:id — get claim status by ID */
  @Get(':id')
  @ApiOperation({ summary: 'Get claim details by ID' })
  @ApiParam({ name: 'id', description: 'Claim UUID' })
  @ApiResponse({ status: 200, description: 'Returns claim details' })
  @ApiResponse({ status: 404, description: 'Claim not found' })
  async getClaim(@Param('id') id: string) {
    const claim = await this.claims.getClaim(id);
    if (!claim) return { success: false, error: 'Claim not found' };
    return { success: true, data: claim };
  }

  /** GET /api/v1/claims/history/:wallet — get all claims for a wallet address */
  @Get('history/:wallet')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all claims for a wallet address' })
  @ApiParam({ name: 'wallet', description: 'Stellar wallet address' })
  @ApiResponse({ status: 200, description: 'Returns claim history for the wallet' })
  async getClaimHistory(@Req() req: Request & { user?: any }, @Param('wallet') wallet: string) {
    if (wallet !== req.user?.walletAddress) {
      throw new UnauthorizedException('Cannot read claims for another wallet');
    }
    const history = await this.claims.getClaimsByWallet(wallet);
    return { success: true, data: history };
  }
}
