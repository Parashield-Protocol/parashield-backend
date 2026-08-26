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

// #437 — Retry configuration for failed webhook deliveries.
// Up to MAX_RETRY_ATTEMPTS additional attempts after the initial failure,
// with exponential backoff starting at RETRY_BASE_DELAY_MS and doubling
// each attempt (1 s → 2 s → 4 s by default).
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;

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

    for (const registration of registrations) {
      if (!registration.events.includes('policy.status.change')) continue;

      const payload = {
        policyId: event.policyId,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        timestamp: event.timestamp,
      };

      try {
        await this.deliverWithRetry(registration, payload);
      } catch (err) {
        this.logger.error(
          `All delivery attempts failed for policy webhook ${registration.id} → ${registration.url}: ${(err as Error).message}`,
        );
      }
    }
  }

  async notifyClaimStatusChange(event: { claimId: string; fromStatus: string; toStatus: string; timestamp: number }) {
    const registrations = this.getRegistrations();

    for (const registration of registrations) {
      if (!registration.events.includes('claim.status.change')) continue;

      const payload = {
        claimId: event.claimId,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        timestamp: event.timestamp,
      };

      try {
        await this.deliverWithRetry(registration, payload);
      } catch (err) {
        this.logger.error(
          `All delivery attempts failed for claim webhook ${registration.id} → ${registration.url}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * #437 — Deliver a webhook payload with exponential backoff retries.
   *
   * Attempt sequence (attempt numbers are 0-indexed):
   *   - Attempt 0: immediate
   *   - Attempt 1: wait RETRY_BASE_DELAY_MS  (1 s)
   *   - Attempt 2: wait RETRY_BASE_DELAY_MS * 2  (2 s)
   *   - Attempt 3: wait RETRY_BASE_DELAY_MS * 4  (4 s)
   *
   * Throws on the last attempt so callers can log the final failure.
   */
  private async deliverWithRetry(registration: WebhookRegistration, payload: unknown): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        this.logger.warn(
          `Retrying webhook ${registration.id} → ${registration.url} ` +
          `(attempt ${attempt}/${MAX_RETRY_ATTEMPTS}, backoff ${delayMs} ms): ${lastError?.message}`,
        );
        await this.sleep(delayMs);
      }

      try {
        await this.deliverWebhook(registration, payload);
        if (attempt > 0) {
          this.logger.log(
            `Webhook ${registration.id} → ${registration.url} succeeded on attempt ${attempt}`,
          );
        }
        return;
      } catch (err) {
        lastError = err as Error;
      }
    }

    throw lastError!;
  }

  private async deliverWebhook(registration: WebhookRegistration, payload: unknown): Promise<void> {
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}