import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Sse,
  MessageEvent,
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
import { Observable } from 'rxjs';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import { PolicyService } from './policy.service';
import { BuyPolicyDto } from './dto/buy-policy.dto';
import { ConfirmPolicyDto } from './dto/confirm-policy.dto';
import { CreateProductDto, UpdateProductDto } from './dto/admin-product.dto';
import { ProductResponseDto, PolicyResponseDto } from './dto/policy-response.dto';
import { ResponseDto, PaginatedResponseDto } from '../common/dto/response.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OperatorAuthGuard } from '../auth/operator-auth.guard';
import { AuthenticatedRequest } from '../auth/authenticated-request';
import { StatusEventsService } from '../common/events/status-events.service';
import { PolicyStatusEventDto } from '../common/events/dto/sse-event.dto';

@ApiTags('policy')
@Controller()
@ApiExtraModels(ResponseDto, PaginatedResponseDto, ProductResponseDto, PolicyResponseDto, PolicyStatusEventDto)
export class PolicyController {
  constructor(
    private readonly policy: PolicyService,
    private readonly statusEvents: StatusEventsService,
  ) {}

  /** GET /api/v1/products — list all active insurance products with pagination */
  @Get('products')
  @ApiOperation({ summary: 'List all active insurance products with pagination' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number (default 1)', example: 1 })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page, max 100 (default 20)', example: 20 })
  @ApiResponse({
    status: 200,
    description: 'Returns paginated products — { success, data, total, page, limit }',
    schema: {
      allOf: [
        { $ref: getSchemaPath(ResponseDto) },
        {
          properties: {
            data: { type: 'array', items: { $ref: getSchemaPath(ProductResponseDto) } },
          },
        },
      ],
    },
  })
  async getProducts(
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
  ) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const result = await this.policy.getActiveProducts(pageNum, limitNum);
    return { success: true, ...result };
  }

  /** GET /api/v1/policies/me?page=&limit= — get paginated policies for the authenticated wallet */
  @Get('policies/me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get paginated policies for the authenticated wallet' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number (default 1)', example: 1 })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page, max 100 (default 20)', example: 20 })
  @ApiResponse({
    status: 200,
    description: 'Returns paginated policies — { success, data, total, page, limit }',
    schema: {
      allOf: [
        { $ref: getSchemaPath(PaginatedResponseDto) },
        {
          properties: {
            data: { type: 'array', items: { $ref: getSchemaPath(PolicyResponseDto) } },
          },
        },
      ],
    },
  })
  async getMyPolicies(
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
    @Req() req: AuthenticatedRequest,
  ) {
    // #345 — wallet used to come from a client-supplied query param, checked
    // only for authorization against the JWT wallet; the JWT wallet was
    // always the one actually used, making the param redundant and confusing.
    const authedWallet = req.user?.walletAddress || req.wallet;
    if (!authedWallet) {
      throw new BadRequestException('Not authenticated');
    }
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const result = await this.policy.getUserPolicies(authedWallet, pageNum, limitNum);
    return { success: true, ...result };
  }

  /** GET /api/v1/policies/:id — get a single policy by ID (owner only) */
  @Get('policies/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get a single policy by ID' })
  @ApiParam({ name: 'id', description: 'Policy UUID' })
  @ApiResponse({
    status: 200,
    description: 'Returns the policy details',
    schema: {
      allOf: [
        { $ref: getSchemaPath(ResponseDto) },
        { properties: { data: { $ref: getSchemaPath(PolicyResponseDto) } } },
      ],
    },
  })
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
  @ApiResponse({
    status: 200,
    description: 'Returns premium quote for the requested coverage',
    schema: {
      allOf: [
        { $ref: getSchemaPath(ResponseDto) },
        {
          properties: {
            data: {
              type: 'object',
              properties: {
                quote: {
                  type: 'object',
                  properties: {
                    productId:   { type: 'string' },
                    productName: { type: 'string' },
                    coverageXlm: { type: 'number' },
                    premiumXlm:  { type: 'number' },
                    duration:    { type: 'number' },
                    wallet:      { type: 'string' },
                  },
                },
              },
            },
          },
        },
      ],
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid request body, pool capacity exceeded, or malformed oracleKey' })
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

    // #131: validate pool capacity; #132: validate oracleKey format at quote time
    const validation = await this.policy.validateCoverage(dto.coverageXlm, product, dto.oracleKey);
    if (!validation.valid) {
      throw new BadRequestException(validation.reason);
    }

    await this.policy.validatePoolCapacity(dto.coverageXlm);

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
  @ApiResponse({
    status: 200,
    description: 'Policy created on-chain and persisted; returns policyId and txHash',
    schema: {
      allOf: [
        { $ref: getSchemaPath(ResponseDto) },
        {
          properties: {
            data: {
              type: 'object',
              properties: {
                policyId: { type: 'string' },
                txHash:   { type: 'string' },
              },
            },
          },
        },
      ],
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid request body or on-chain submission failed' })
  @ApiResponse({ status: 409, description: 'Policy already exists for this wallet, product, and oracle key' })
  @ApiResponse({ status: 410, description: 'Signed XDR has expired' })
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

  /** POST /api/v1/policies/:id/cancel — policyholder voluntarily cancels an ACTIVE policy */
  @Post('policies/:id/cancel')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel an active policy' })
  @ApiParam({ name: 'id', description: 'Policy UUID' })
  @ApiResponse({
    status: 200,
    description: 'Policy cancelled',
    schema: {
      allOf: [
        { $ref: getSchemaPath(ResponseDto) },
        { properties: { data: { $ref: getSchemaPath(PolicyResponseDto) } } },
      ],
    },
  })
  @ApiResponse({ status: 403, description: 'Policy belongs to a different wallet' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  @ApiResponse({ status: 409, description: 'Policy is no longer ACTIVE and cannot be cancelled' })
  async cancelPolicy(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const policyData = await this.policy.getPolicy(id);
    if (!policyData) {
      throw new NotFoundException(`Policy ${id} not found`);
    }
    const authedWallet = req.user?.walletAddress || req.wallet;
    if (policyData.policyholder !== authedWallet) {
      throw new ForbiddenException('Policy belongs to a different wallet');
    }
    const result = await this.policy.cancelPolicy(id);
    return { success: true, data: result };
  }

  // #347 — admin-only product management. Gated by OperatorAuthGuard, the
  // same admin-key-or-admin-JWT guard already used for oracle/claims admin
  // routes, rather than a new auth mechanism.

  /** POST /api/v1/admin/products — create a new insurance product */
  @Post('admin/products')
  @UseGuards(OperatorAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Create a new insurance product' })
  @ApiResponse({
    status: 201,
    description: 'Product created',
    schema: {
      allOf: [
        { $ref: getSchemaPath(ResponseDto) },
        { properties: { data: { $ref: getSchemaPath(ProductResponseDto) } } },
      ],
    },
  })
  @HttpCode(HttpStatus.CREATED)
  async createProduct(@Body() dto: CreateProductDto) {
    const product = await this.policy.createProduct(dto);
    return { success: true, data: product };
  }

  /** PATCH /api/v1/admin/products/:id — update an insurance product */
  @Patch('admin/products/:id')
  @UseGuards(OperatorAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Update an insurance product' })
  @ApiParam({ name: 'id', description: 'Product UUID' })
  @ApiResponse({
    status: 200,
    description: 'Product updated',
    schema: {
      allOf: [
        { $ref: getSchemaPath(ResponseDto) },
        { properties: { data: { $ref: getSchemaPath(ProductResponseDto) } } },
      ],
    },
  })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async updateProduct(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    const product = await this.policy.updateProduct(id, dto);
    return { success: true, data: product };
  }

  /** DELETE /api/v1/admin/products/:id — deactivate an insurance product */
  @Delete('admin/products/:id')
  @UseGuards(OperatorAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Deactivate an insurance product (soft delete)' })
  @ApiParam({ name: 'id', description: 'Product UUID' })
  @ApiResponse({
    status: 200,
    description: 'Product deactivated',
    schema: {
      allOf: [
        { $ref: getSchemaPath(ResponseDto) },
        { properties: { data: { $ref: getSchemaPath(ProductResponseDto) } } },
      ],
    },
  })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async deactivateProduct(@Param('id') id: string) {
    const product = await this.policy.deactivateProduct(id);
    return { success: true, data: product };
  }

  /**
   * GET /api/v1/policies/:id/events — Server-Sent Events stream of status
   * changes for a policy (#349), so the frontend doesn't have to poll.
   * Ownership-checked the same way as GET /policies/:id.
   */
  @Sse('policies/:id/events')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Server-Sent Events stream of status changes for a policy',
    description:
      'Opens an SSE connection that streams policy status transitions in real time. ' +
      'The current status is emitted immediately on connection, followed by events whenever the status changes. ' +
      'Possible status values: ACTIVE, PROCESSING, CLAIMED, CANCELLED, EXPIRED.\n\n' +
      'Event data schema:\n' +
      '```json\n' +
      '{ "policyId": "uuid", "status": "ACTIVE", "timestamp": 1700000000000 }\n' +
      '```\n\n' +
      'Connect with `EventSource`:\n' +
      '```js\n' +
      'const es = new EventSource("/api/v1/policies/:id/events", { withCredentials: true });\n' +
      "es.onmessage = (e) => console.log(JSON.parse(e.data));\n" +
      '```',
  })
  @ApiParam({ name: 'id', description: 'Policy UUID' })
  @ApiResponse({
    status: 200,
    description: 'SSE stream of PolicyStatusEvent objects. Each message has a `data` field containing the event payload.',
    schema: { $ref: getSchemaPath(PolicyStatusEventDto) },
  })
  @ApiResponse({ status: 403, description: 'Policy belongs to a different wallet' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  async policyStatusEvents(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<Observable<MessageEvent>> {
    const policyData = await this.policy.getPolicy(id);
    if (!policyData) {
      throw new NotFoundException(`Policy ${id} not found`);
    }
    const authedWallet = req.user?.walletAddress || req.wallet;
    if (policyData.policyholder !== authedWallet) {
      throw new ForbiddenException('Policy belongs to a different wallet');
    }

    return new Observable<MessageEvent>((subscriber) => {
      // Emit the current status immediately so a client doesn't have to wait
      // for the next transition just to know where things stand.
      subscriber.next({ data: { policyId: id, status: policyData.status, timestamp: Date.now() } });

      const unsubscribe = this.statusEvents.subscribeToPolicyStatus(id, (event) => {
        subscriber.next({ data: event });
      });
      return () => unsubscribe();
    });
  }
}
