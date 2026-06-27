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
  UseGuards,
  Req,
  UnauthorizedException,
  Req,
  UseGuards,
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
import { Request } from 'express';
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
    wallet = wallet || req.wallet;
    if (!wallet) {
      throw new BadRequestException('wallet query param required');
    }
    if (wallet !== req.user?.walletAddress) {
      throw new UnauthorizedException('Cannot fetch policies for another wallet');
    }
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const result = await this.policy.getUserPolicies(wallet, pageNum, limitNum);
    return { success: true, ...result };
  }

  /** GET /api/v1/policies/:id — get a single policy by ID */
  @Get('policies/:id')
  @ApiOperation({ summary: 'Get a single policy by ID' })
  @ApiParam({ name: 'id', description: 'Policy UUID' })
  @ApiResponse({ status: 200, description: 'Returns the policy details' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  async getPolicy(@Param('id') id: string) {
    const policyData = await this.policy.getPolicy(id);
    if (!policyData) {
      throw new NotFoundException(`Policy ${id} not found`);
    }
    return { success: true, data: policyData };
  }

  /** POST /api/v1/policies/buy — calculate premium and return quote */
  @Post('policies/buy')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get premium quote for requested coverage' })
  @ApiResponse({ status: 200, description: 'Returns premium quote for the requested coverage' })
  @ApiResponse({ status: 400, description: 'Invalid request body' })
  async buyPolicy(@Req() req: Request & { user?: any }, @Body() dto: BuyPolicyDto) {
    if (dto.walletAddress !== req.user?.walletAddress) {
      throw new UnauthorizedException('Wallet address does not match authenticated user');
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
  async confirmPolicy(@Body() dto: ConfirmPolicyDto) {
    const result = await this.policy.confirmAndCreatePolicy(dto);
    return { success: true, data: result };
  }
}
