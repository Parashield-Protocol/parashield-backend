import { Controller, Post, Body, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiExtraModels, getSchemaPath } from '@nestjs/swagger';
import { ApiErrorResponse } from '../swagger/api-error-responses';
import { WebhooksService } from '../events/webhooks.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RegisterWebhookDto,
  WebhookRegistrationResponseDto,
  WebhookListItemDto,
  PolicyStatusChangePayloadDto,
  ClaimStatusChangePayloadDto,
} from './dto/webhook.dto';

/**
 * Registrations are cheap to create but expensive to serve — every status
 * event fans out to every active row — so POST /register gets a much tighter
 * window than the app-wide 60 req / 60 s default. UserThrottlerGuard keys the
 * counter on the caller's wallet when a JWT is present, falling back to IP.
 */
const REGISTER_THROTTLE = { default: { limit: 10, ttl: 60000 } };

@Controller('webhooks')
@ApiTags('webhooks')
@ApiExtraModels(RegisterWebhookDto, WebhookRegistrationResponseDto, WebhookListItemDto, PolicyStatusChangePayloadDto, ClaimStatusChangePayloadDto)
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * POST /api/v1/webhooks/register — register a webhook endpoint
   *
   * Rate limited: 10 registrations / 60 s per IP (per authenticated wallet
   * when a JWT is presented).
   */
  @Post('register')
  @Throttle(REGISTER_THROTTLE)
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
      '```\n\n' +
      '**Retry behaviour:** Failed deliveries are automatically retried up to 3 times using exponential backoff ' +
      '(delays: 1 s → 2 s → 4 s). If all attempts fail the error is logged and the event is dropped.',
  })
  @ApiBearerAuth()
  @ApiResponse({ status: 201, description: 'Webhook registered successfully', schema: { $ref: getSchemaPath(WebhookRegistrationResponseDto) } })
  @ApiErrorResponse(400, 'Request body failed validation (missing url, unsupported event type, etc.).', undefined, 'url must be a URL address; events must contain only supported event types')
  @ApiErrorResponse(429, 'Rate limit exceeded — webhook registration allows 10 req / 60 s.', undefined, 'Too many requests. Please try again later.')
  async register(@Body() dto: RegisterWebhookDto) {
    const result = await this.webhooks.registerWebhook({
      url: dto.url,
      events: dto.events,
      secret: dto.secret,
    });
    return { success: true, data: result };
  }

  /** GET /api/v1/webhooks — list all registered webhooks */
  @Get()
  @ApiOperation({ summary: 'List all registered webhooks' })
  @ApiBearerAuth()
  @ApiResponse({
    status: 200,
    description: 'Returns list of active webhook registrations',
    schema: {
      allOf: [
        {
          properties: {
            success: { type: 'boolean', example: true },
            data: { type: 'array', items: { $ref: getSchemaPath(WebhookListItemDto) } },
          },
        },
      ],
    },
  })
  async list() {
    // Never echo the HMAC signing secret back to API callers.
    const registrations = await this.webhooks.getRegistrations();
    return { success: true, data: registrations.map(({ secret: _secret, ...rest }) => rest) };
  }
}