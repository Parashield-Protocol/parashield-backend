import { Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, UseGuards, UnauthorizedException, NotFoundException } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { ClaimsService } from './claims.service';
import { SubmitClaimDto } from './dto/submit-claim.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OperatorAuthGuard } from '../auth/operator-auth.guard';
import { AuthenticatedRequest } from '../auth/authenticated-request';

@ApiTags('claims')
@Controller('claims')
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  /** POST /api/v1/claims — submit a manual claim */
  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Submit a manual claim for a policy' })
  @ApiResponse({ status: 201, description: 'Claim submitted successfully' })
  @ApiResponse({ status: 403, description: 'Claimant does not match authenticated wallet' })
  @ApiResponse({ status: 409, description: 'Claim already exists for this policy' })
  async submitClaim(@Body() dto: SubmitClaimDto, @Req() req: AuthenticatedRequest) {
    const authedWallet = req.user?.walletAddress || req.wallet;
    if (!authedWallet) {
      throw new UnauthorizedException('Not authenticated');
    }
    if (dto.claimant && dto.claimant !== authedWallet) {
      throw new ForbiddenException('Claimant does not match authenticated wallet');
    }
    const claimId = await this.claims.submitClaim(authedWallet, dto.policyId);
    return { success: true, data: { claimId } };
  }

  /** GET /api/v1/claims?wallet=... — get claim history for the authenticated wallet */
  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get claim history for a wallet address (query param)' })
  @ApiQuery({ name: 'wallet', required: true, description: 'Stellar wallet address' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page' })
  @ApiResponse({ status: 200, description: 'Returns claim history for the wallet' })
  @ApiResponse({ status: 403, description: 'Wallet does not match authenticated user' })
  async getClaimsByWalletQuery(
    @Query('wallet') wallet: string,
    @Query('page') page: string,
    @Query('limit') limit: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const authedWallet = req.user?.walletAddress || req.wallet;
    if (!authedWallet) {
      throw new UnauthorizedException('Not authenticated');
    }
    const targetWallet = wallet || authedWallet;
    if (targetWallet !== authedWallet) {
      throw new ForbiddenException('Wallet address does not match authenticated user');
    }
    const result = await this.claims.getClaimsByWallet(
      targetWallet,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
    return { success: true, data: result };
  }

  /** POST /api/v1/claims/:policyId/auto — keeper triggers auto-processing */
  @Post(':policyId/auto')
  @UseGuards(OperatorAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Trigger automatic claim evaluation for a policy (operator only)' })
  @ApiParam({ name: 'policyId', description: 'Policy UUID to evaluate' })
  @ApiResponse({ status: 201, description: 'Claim evaluation triggered' })
  @ApiResponse({ status: 401, description: 'Operator API key or admin bearer token required' })
  async autoProcess(@Param('policyId') policyId: string) {
    const result = await this.claims.autoProcess(policyId);
    return { success: true, data: { result } };
  }

  /** GET /api/v1/claims/:id — get claim status by ID (owner only) */
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get claim details by ID' })
  @ApiParam({ name: 'id', description: 'Claim UUID' })
  @ApiResponse({ status: 200, description: 'Returns claim details' })
  @ApiResponse({ status: 403, description: 'Claim belongs to a different wallet' })
  @ApiResponse({ status: 404, description: 'Claim not found' })
  async getClaim(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const claim = await this.claims.getClaim(id);
    if (!claim) {
      throw new NotFoundException('Claim not found');
    }
    const authedWallet = req.user?.walletAddress || req.wallet;
    if (claim.claimant !== authedWallet) {
      throw new ForbiddenException('Claim belongs to a different wallet');
    }
    return { success: true, data: claim };
  }

  /** GET /api/v1/claims/history/:wallet — get all claims for a wallet address */
  @Get('history/:wallet')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all claims for a wallet address' })
  @ApiParam({ name: 'wallet', description: 'Stellar wallet address' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page' })
  @ApiResponse({ status: 200, description: 'Returns claim history for the wallet' })
  async getClaimHistory(
    @Param('wallet') wallet: string,
    @Query('page') page: string,
    @Query('limit') limit: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const authedWallet = req.user?.walletAddress || req.wallet;
    if (!authedWallet) {
      throw new UnauthorizedException('Not authenticated');
    }
    const targetWallet = wallet || authedWallet;
    if (targetWallet !== authedWallet) {
      throw new ForbiddenException('Cannot read claims for another wallet');
    }
    const result = await this.claims.getClaimsByWallet(
      targetWallet,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
    return { success: true, data: result };
  }
}
