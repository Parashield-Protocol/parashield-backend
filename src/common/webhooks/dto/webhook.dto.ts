import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUrl, IsArray, ArrayNotEmpty, ArrayUnique, IsOptional, IsString, IsEnum } from 'class-validator';

export enum WebhookEventType {
  POLICY_STATUS_CHANGE = 'policy.status.change',
  CLAIM_STATUS_CHANGE = 'claim.status.change',
}

export class RegisterWebhookDto {
  @ApiProperty({ description: 'URL to receive webhook POST requests', example: 'https://example.com/webhook' })
  @IsUrl()
  url: string;

  @ApiProperty({
    description: 'Event types to subscribe to',
    enum: WebhookEventType,
    isArray: true,
    example: [WebhookEventType.POLICY_STATUS_CHANGE, WebhookEventType.CLAIM_STATUS_CHANGE],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsEnum(WebhookEventType, { each: true })
  events: WebhookEventType[];

  @ApiPropertyOptional({
    description: 'Shared secret for HMAC-SHA256 signature verification. If provided, each delivery includes an X-Webhook-Signature header.',
    example: 'whsec_abc123',
  })
  @IsOptional()
  @IsString()
  secret?: string;
}

export class WebhookRegistrationResponseDto {
  @ApiProperty({ description: 'Unique webhook registration ID', example: '1700000000000-abc1234' })
  id: string;

  @ApiProperty({ description: 'Registration status', example: 'registered' })
  status: string;
}

export class WebhookListItemDto {
  @ApiProperty({ description: 'Unique webhook registration ID', example: '1700000000000-abc1234' })
  id: string;

  @ApiProperty({ description: 'Target URL for deliveries', example: 'https://example.com/webhook' })
  url: string;

  @ApiProperty({ description: 'Subscribed event types', enum: WebhookEventType, isArray: true })
  events: WebhookEventType[];

  @ApiProperty({ description: 'Whether the webhook is active', example: true })
  isActive: boolean;

  @ApiProperty({ description: 'Registration timestamp' })
  createdAt: Date;
}

export class PolicyStatusChangePayloadDto {
  @ApiProperty({ description: 'Policy UUID', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  policyId: string;

  @ApiProperty({ description: 'Previous policy status', example: 'ACTIVE', enum: ['ACTIVE', 'EXPIRED', 'CANCELLED', 'CLAIMED', 'PROCESSING'] })
  fromStatus: string;

  @ApiProperty({ description: 'New policy status', example: 'CLAIMED', enum: ['ACTIVE', 'EXPIRED', 'CANCELLED', 'CLAIMED', 'PROCESSING'] })
  toStatus: string;

  @ApiProperty({ description: 'Unix timestamp in milliseconds', example: 1700000000000 })
  timestamp: number;
}

export class ClaimStatusChangePayloadDto {
  @ApiProperty({ description: 'Claim UUID', example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901' })
  claimId: string;

  @ApiProperty({ description: 'Previous claim status', example: 'PROCESSING' })
  fromStatus: string;

  @ApiProperty({ description: 'New claim status', example: 'PAID' })
  toStatus: string;

  @ApiProperty({ description: 'Unix timestamp in milliseconds', example: 1700000000000 })
  timestamp: number;
}
