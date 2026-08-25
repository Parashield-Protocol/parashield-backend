import { Controller, Post, Body, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { WebhooksService } from '../events/webhooks.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('webhooks')
@ApiTags('webhooks')
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly prisma: PrismaService,
  ) {}

  /** POST /api/v1/webhooks/register — register a webhook endpoint */
  @Post('register')
  @ApiOperation({ summary: 'Register a webhook for policy/claim status changes' })
  @ApiBearerAuth()
  @ApiResponse({ status: 201, description: 'Webhook registered successfully' })
  @ApiResponse({ status: 400, description: 'Invalid request body' })
  register(@Body() dto: { url: string; events: string[]; secret?: string }) {
    return this.webhooks.registerWebhook({
      url: dto.url,
      events: dto.events as ('policy.status.change' | 'claim.status.change')[],
      secret: dto.secret,
    });
  }

  /** GET /api/v1/webhooks — list all registered webhooks */
  @Get()
  @ApiOperation({ summary: 'List all registered webhooks' })
  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'Returns list of registered webhooks' })
  list() {
    return this.webhooks.getRegistrations();
  }
}