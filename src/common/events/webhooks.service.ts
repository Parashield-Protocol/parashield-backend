import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface WebhookRegistration {
  id: string;
  url: string;
  secret?: string;
  events: ('policy.status.change' | 'claim.status.change')[];
  createdAt: Date;
  isActive: boolean;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly registrations = new Map<string, WebhookRegistration>();

  constructor(private readonly prisma: PrismaService) {}

  registerWebhook(dto: { url: string; events: ('policy.status.change' | 'claim.status.change')[]; secret?: string }) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const registration: WebhookRegistration = {
      id,
      url: dto.url,
      secret: dto.secret,
      events: dto.events,
      createdAt: new Date(),
      isActive: true,
    };

    this.registrations.set(id, registration);
    this.logger.log(`Webhook registered: ${id} → ${dto.url} for events: ${dto.events.join(', ')}`);
    return { id, status: 'registered' };
  }

  unregisterWebhook(id: string) {
    const registration = this.registrations.get(id);
    if (registration) {
      registration.isActive = false;
      this.registrations.delete(id);
      this.logger.log(`Webhook unregistered: ${id}`);
      return { id, status: 'unregistered' };
    }
    throw new BadRequestException(`Webhook ${id} not found`);
  }

  getRegistrations(): WebhookRegistration[] {
    return Array.from(this.registrations.values()).filter((r) => r.isActive);
  }

  async notifyPolicyStatusChange(event: { policyId: string; fromStatus: string; toStatus: string; timestamp: number }) {
    const registrations = this.getRegistrations();
    const policyEventKey = `policy:${event.policyId}`;

    for (const registration of registrations) {
      if (!registration.events.includes('policy.status.change')) continue;

      const payload = {
        policyId: event.policyId,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        timestamp: event.timestamp,
      };

      try {
        await this.deliverWebhook(registration, payload);
      } catch (err) {
        this.logger.error(`Failed to deliver policy webhook to ${registration.url}: ${(err as Error).message}`);
      }
    }
  }

  async notifyClaimStatusChange(event: { claimId: string; fromStatus: string; toStatus: string; timestamp: number }) {
    const registrations = this.getRegistrations();
    const claimEventKey = `claim:${event.claimId}`;

    for (const registration of registrations) {
      if (!registration.events.includes('claim.status.change')) continue;

      const payload = {
        claimId: event.claimId,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        timestamp: event.timestamp,
      };

      try {
        await this.deliverWebhook(registration, payload);
      } catch (err) {
        this.logger.error(`Failed to deliver claim webhook to ${registration.url}: ${(err as Error).message}`);
      }
    }
  }

  private async deliverWebhook(registration: WebhookRegistration, payload: unknown) {
    const secret = registration.secret;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (secret) {
      headers['X-Webhook-Signature'] = this.signPayload(payload, secret);
    }

    const response = await fetch(registration.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Webhook responded with ${response.status}`);
    }
  }

  private signPayload(payload: unknown, secret: string): string {
    const crypto = require('crypto');
    const payloadStr = JSON.stringify(payload);
    return crypto.createHmac('sha256', secret).update(payloadStr).digest('base64');
  }
}