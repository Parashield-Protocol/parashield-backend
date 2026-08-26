import { Controller, Post, Body, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiExtraModels, getSchemaPath } from '@nestjs/swagger';
import { WebhooksService } from '../events/webhooks.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  RegisterWebhookDto,
  WebhookRegistrationResponseDto,
  WebhookListItemDto,
  PolicyStatusChangePayloadDto,
  ClaimStatusChangePayloadDto,
} from './dto/webhook.dto';

@Controller('webhooks')
@ApiTags('webhooks')
@ApiExtraModels(RegisterWebhookDto, WebhookRegistrationResponseDto, WebhookListItemDto, PolicyStatusChangePayloadDto, ClaimStatusChangePayloadDto)
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly prisma: PrismaService,
  ) {}

  /** POST /api/v1/webhooks/register — register a webhook endpoint */
  @Post('register')
  @ApiOperation({
    summary: 'Register a webhook for real-time event notifications',
    description:
      'Register a URL to receive POST requests when specific events occur. ' +
      'Supported event types:\n\n' +
      '| Event | Description | Payload |\n' +
      '|-------|-------------|---------|\n' +
      '| `policy.status.change` | A policy status transition (e.g. ACTIVE → CLAIMED) | `{ policyId, fromStatus, toStatus, timestamp }` |\n' +
      '| `claim.status.change` | A claim status transition (e.g. PROCESSING → PAID) | `{ claimId, fromStatus, toStatus, timestamp }` |\n\n' +
      '**Signature verification:** If a `secret` is provided, each delivery includes an `X-Webhook-Signature` header ' +
      'containing an HMAC-SHA256 digest of the JSON payload, base64-encoded. Verify with:\n' +
      '```\n' +
      'crypto.createHmac("sha256", secret).update(rawBody).digest("base64")\n' +
      '```',
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: 201,
    description: 'Webhook registered successfully',
    schema: { $ref: getSchemaPath(WebhookRegistrationResponseDto) },
  })
  @ApiResponse({ status: 400, description: 'Invalid request body' })
  register(@Body() dto: RegisterWebhookDto) {
    return this.webhooks.registerWebhook({
      url: dto.url,
      events: dto.events,
      secret: dto.secret,
    });
  }

  /** GET /api/v1/webhooks — list all registered webhooks */
  @Get()
  @ApiOperation({ summary: 'List all registered webhooks' })
  @ApiBearerAuth()
  @ApiResponse({
    status: 200,
    description: 'Returns list of active webhook registrations',
    schema: { type: 'array', items: { $ref: getSchemaPath(WebhookListItemDto) } },
  })
  list() {
    return this.webhooks.getRegistrations();
  }
}