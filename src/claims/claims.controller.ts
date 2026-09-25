import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards, UseInterceptors, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { StreamingInterceptor } from '../common/interceptors/streaming.interceptor';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorResponse } from '../common/swagger/api-error-responses';
import { ClaimsService } from './claims.service';
import { SubmitClaimDto } from './dto/submit-claim.dto';
import { ResponseDto, PaginatedResponseDto } from '../common/dto/response.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OperatorAuthGuard } from '../auth/operator-auth.guard';
import { AuthenticatedRequest } from '../auth/authenticated-request';
import { ErrorCode } from '../common/errors/error-codes';

@ApiTags('claims')
@Controller('claims')
@ApiExtraModels(ResponseDto, PaginatedResponseDto)
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  /** POST /api/v1/claims — submit a manual claim */
  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  // Manual claim submission gets a tighter limit than the app-wide default
  // (60 req/60s) configured in app.module.ts, to slow down abuse of claim payouts.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Submit a manual claim for a policy' })
  @ApiResponse({ status: 201, description: 'Claim submitted successfully', schema: { allOf: [ { $ref: getSchemaPath(ResponseDto) }, { properties: { data: { type: 'object', properties: { claimId: { type: 'string' }, claim: { type: 'object', description: 'Initial claim details' } } } } }, ], }, })
  @ApiErrorResponse(403, 'Claimant field does not match the authenticated wallet address.', undefined, 'Claimant does not match authenticated wallet')
  @ApiErrorResponse(409, 'An active claim already exists for this policy.', undefined, 'An active claim already exists for this policy')
  @ApiErrorResponse(429, 'Rate limit exceeded — claim submission allows 5 req / 60 s.', undefined, 'Too many requests. Please try again later.')
  async submitClaim(@Body() dto: SubmitClaimDto, @Req() req: AuthenticatedRequest) {
    const authedWallet = req.user?.walletAddress || req.wallet;
    if (!authedWallet) {
      throw new UnauthorizedException('Not authenticated');
    }
    if (dto.claimant && dto.claimant !== authedWallet) {
      throw new ForbiddenException({ message: 'Claimant does not match authenticated wallet', errorCode: ErrorCode.CLAIM_CLAIMANT_MISMATCH });
    }
    const claimId = await this.claims.submitClaim(authedWallet, dto.policyId);
    const claim = await this.claims.getClaim(claimId);
    return { success: true, data: { claimId, claim } };
  }

  /** GET /api/v1/claims?wallet=... — get claim history for the authenticated wallet */
  @Get()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(StreamingInterceptor)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get claim history for a wallet address (query param)' })
  @ApiQuery({ name: 'wallet', required: true, description: 'Stellar wallet address' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number (default 1)', example: 1 })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page, max 100 (default 20)', example: 20 })
  @ApiQuery({
    name: 'stream',
    required: false,
    description: "Set to 'true' to receive the data array as NDJSON (one item per line). Alternatively send Accept: application/x-ndjson. Pagination metadata available in X-Total-Count, X-Page, X-Limit headers.",
    example: 'true',
  })
  @ApiResponse({ status: 200, description: 'Returns paginated claim history — { success, data, total, page, limit }', schema: { $ref: getSchemaPath(PaginatedResponseDto) } })
  @ApiErrorResponse(403, 'Wallet query parameter does not match the authenticated wallet.', undefined, 'Wallet address does not match authenticated user')
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
      throw new ForbiddenException({ message: 'Wallet address does not match authenticated user', errorCode: ErrorCode.CLAIM_WALLET_MISMATCH });
    }
    const result = await this.claims.getClaimsByWallet(
      targetWallet,
      page ? parseInt(page, 10) || 1 : 1,
      limit ? parseInt(limit, 10) || 20 : 20,
    );
    return { success: true, ...result };
  }

  /** POST /api/v1/claims/:policyId/auto — keeper triggers auto-processing */
  @Post(':policyId/auto')
  @UseGuards(OperatorAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Trigger automatic claim evaluation for a policy (operator only)' })
  @ApiParam({ name: 'policyId', description: 'Policy UUID to evaluate' })
  @ApiResponse({ status: 201, description: 'Claim evaluation triggered', schema: { allOf: [ { $ref: getSchemaPath(ResponseDto) }, { properties: { data: { type: 'object', properties: { result: { type: 'string' } } } } } ] } })
  @ApiErrorResponse(400, 'policyId is not a valid UUID.', undefined, 'Validation failed (uuid is expected)')
  @ApiErrorResponse(401, 'Operator API key (x-api-key) or admin bearer token required.', undefined, 'Missing or invalid operator API key')
  async autoProcess(@Param('policyId', ParseUUIDPipe) policyId: string) {
    const result = await this.claims.autoProcess(policyId);
    return { success: true, data: { result } };
  }

  /** GET /api/v1/claims/:id — get claim status by ID (owner only) */
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get claim details by ID' })
  @ApiParam({ name: 'id', description: 'Claim UUID' })
  @ApiResponse({ status: 200, description: 'Returns claim details', schema: { $ref: getSchemaPath(ResponseDto) } })
  @ApiErrorResponse(403, 'Claim belongs to a different wallet.', undefined, 'Claim belongs to a different wallet')
  @ApiErrorResponse(404, 'No claim found for the given ID.', undefined, 'Claim not found')
  async getClaim(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const claim = await this.claims.getClaim(id);
    if (!claim) {
      throw new NotFoundException({ message: 'Claim not found', errorCode: ErrorCode.CLAIM_NOT_FOUND });
    }
    const authedWallet = req.user?.walletAddress || req.wallet;
    if (claim.claimant !== authedWallet) {
      throw new ForbiddenException({ message: 'Claim belongs to a different wallet', errorCode: ErrorCode.CLAIM_WALLET_MISMATCH });
    }
    return { success: true, data: claim };
  }

  /** GET /api/v1/claims/history/:wallet — deprecated alias of GET /api/v1/claims?wallet=... (#579) */
  @Get('history/:wallet')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(StreamingInterceptor)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all claims for a wallet address', deprecated: true, description: 'Deprecated — use GET /claims?wallet=... instead.' })
  @ApiParam({ name: 'wallet', description: 'Stellar wallet address' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number (default 1)', example: 1 })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page, max 100 (default 20)', example: 20 })
  @ApiQuery({
    name: 'stream',
    required: false,
    description: "Set to 'true' to receive the data array as NDJSON (one item per line). Alternatively send Accept: application/x-ndjson. Pagination metadata available in X-Total-Count, X-Page, X-Limit headers.",
    example: 'true',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns paginated claim history — { success, data, total, page, limit }',
    schema: { $ref: getSchemaPath(PaginatedResponseDto) },
  })
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
      throw new ForbiddenException({ message: 'Cannot read claims for another wallet', errorCode: ErrorCode.CLAIM_WALLET_MISMATCH });
    }
    const result = await this.claims.getClaimsByWallet(
      targetWallet,
      page ? parseInt(page, 10) || 1 : 1,
      limit ? parseInt(limit, 10) || 20 : 20,
    );
    return { success: true, ...result };
  }
}
