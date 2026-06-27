import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  UseGuards,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { PolicyService } from './policy.service';
import { BuyPolicyDto } from './dto/buy-policy.dto';
import { ConfirmPolicyDto } from './dto/confirm-policy.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../auth/authenticated-request';

@ApiTags('policy')
@Controller()
export class PolicyController {
  constructor(private readonly policy: PolicyService) {}

  /** GET /api/v1/products — list all active insurance products */
  @Get('products')
  @ApiOperation({ summary: 'List all active insurance products' })
  @ApiResponse({ status: 200, description: 'Returns list of active products' })
  async getProducts() {
    const products = await this.policy.getActiveProducts();
    return { success: true, data: products };
  }

  /** GET /api/v1/policies/me?wallet=<address>&page=&limit= — get paginated policies for a wallet */
  @Get('policies/me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get paginated policies for a wallet address' })
  @ApiQuery({ name: 'wallet', required: true, description: 'Stellar wallet address' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number (default 1)', example: 1 })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page, max 100 (default 20)', example: 20 })
  @ApiResponse({ status: 200, description: 'Returns paginated policies for the wallet — { data, total, page, limit }' })
  async getMyPolicies(
    @Query('wallet') wallet: string,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
    @Req() req: AuthenticatedRequest,
  ) {
    const authedWallet = req.user?.walletAddress || req.wallet;
    if (!authedWallet) {
      throw new BadRequestException('wallet query param required');
    }
    const targetWallet = wallet || authedWallet;
    if (targetWallet !== authedWallet) {
      throw new ForbiddenException('Cannot fetch policies for another wallet');
    }
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const result = await this.policy.getUserPolicies(targetWallet, pageNum, limitNum);
    return { success: true, ...result };
  }

  /** GET /api/v1/policies/:id — get a single policy by ID (owner only) */
  @Get('policies/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get a single policy by ID' })
  @ApiParam({ name: 'id', description: 'Policy UUID' })
  @ApiResponse({ status: 200, description: 'Returns the policy details' })
  @ApiResponse({ status: 403, description: 'Policy belongs to a different wallet' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  async getPolicy(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const policyData = await this.policy.getPolicy(id);
    if (!policyData) {
      throw new NotFoundException(`Policy ${id} not found`);
    }
    const authedWallet = req.user?.walletAddress || req.wallet;
    if (policyData.policyholder !== authedWallet) {
      throw new ForbiddenException('Policy belongs to a different wallet');
    }
    return { success: true, data: policyData };
  }

  /** POST /api/v1/policies/buy — calculate premium and return quote */
  @Post('policies/buy')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get premium quote for requested coverage' })
  @ApiResponse({ status: 200, description: 'Returns premium quote for the requested coverage' })
  @ApiResponse({ status: 400, description: 'Invalid request body' })
  async buyPolicy(@Req() req: AuthenticatedRequest, @Body() dto: BuyPolicyDto) {
    const authedWallet = req.user?.walletAddress || req.wallet;
    if (dto.walletAddress !== authedWallet) {
      throw new ForbiddenException('Wallet address does not match authenticated user');
    }
    const products = await this.policy.getActiveProducts();
    const product = products.find((p) => p.id === dto.productId);

    if (!product) {
      throw new NotFoundException(`Product ${dto.productId} not found`);
    }

    const validation = this.policy.validateCoverage(dto.coverageXlm, product);
    if (!validation.valid) {
      throw new BadRequestException(validation.reason);
    }

    const premiumXlm = this.policy.calculatePremium(
      dto.coverageXlm,
      product.premiumRate,
      dto.duration,
    );

    return {
      success: true,
      data: {
        quote: {
          productId:   dto.productId,
          productName: product.name,
          coverageXlm: dto.coverageXlm,
          premiumXlm,
          duration:    dto.duration,
          wallet:      dto.walletAddress,
        },
      },
    };
  }

  /** POST /api/v1/policies/confirm — submit signed XDR to complete policy purchase */
  @Post('policies/confirm')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Submit signed XDR to complete policy purchase on-chain' })
  @ApiResponse({ status: 200, description: 'Policy created on-chain and persisted; returns policyId and txHash' })
  @ApiResponse({ status: 400, description: 'Invalid request body or on-chain submission failed' })
  async confirmPolicy(@Body() dto: ConfirmPolicyDto, @Req() req: AuthenticatedRequest) {
    const authedWallet = req.user?.walletAddress || req.wallet;
    if (!authedWallet) {
      throw new UnauthorizedException('Not authenticated');
    }
    if (dto.walletAddress !== authedWallet) {
      throw new ForbiddenException('Wallet address does not match authenticated user');
    }
    const result = await this.policy.confirmAndCreatePolicy(dto, authedWallet);
    return { success: true, data: result };
  }
}
