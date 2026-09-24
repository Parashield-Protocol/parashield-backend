import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

type WebhookEvent = 'policy.status.change' | 'claim.status.change';

export interface WebhookRegistration {
  id: string;
  url: string;
  secret?: string;
  events: WebhookEvent[];
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

  constructor(private readonly prisma: PrismaService) {}

  // #482 — registrations are persisted via Prisma (previously an in-memory
  // Map) so they survive restarts and are visible to every instance.
  async registerWebhook(dto: { url: string; events: WebhookEvent[]; secret?: string }) {
    const registration = await this.prisma.webhookRegistration.create({
      data: { url: dto.url, secret: dto.secret, events: dto.events },
    });
    this.logger.log(`Webhook registered: ${registration.id} → ${dto.url} for events: ${dto.events.join(', ')}`);
    return { id: registration.id, status: 'registered' };
  }

  async unregisterWebhook(id: string) {
    const { count } = await this.prisma.webhookRegistration.updateMany({
      where: { id, isActive: true },
      data: { isActive: false },
    });
    if (count === 0) {
      throw new BadRequestException(`Webhook ${id} not found`);
    }
    this.logger.log(`Webhook unregistered: ${id}`);
    return { id, status: 'unregistered' };
  }

  async getRegistrations(): Promise<WebhookRegistration[]> {
    const rows = await this.prisma.webhookRegistration.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      secret: r.secret ?? undefined,
      events: r.events as WebhookEvent[],
      createdAt: r.createdAt,
      isActive: r.isActive,
    }));
  }

  /**
   * Callers (PolicyService, ClaimsService) fire notifications without
   * awaiting them, so a DB failure loading registrations must be logged
   * here rather than surfacing as an unhandled rejection.
   */
  private async getRegistrationsForEvent(event: WebhookEvent): Promise<WebhookRegistration[]> {
    try {
      return (await this.getRegistrations()).filter((r) => r.events.includes(event));
    } catch (err) {
      this.logger.error(`Failed to load webhook registrations for ${event}: ${(err as Error).message}`);
      return [];
    }
  }

  async notifyPolicyStatusChange(event: { policyId: string; fromStatus: string; toStatus: string; timestamp: number }) {
    const registrations = await this.getRegistrationsForEvent('policy.status.change');

    for (const registration of registrations) {
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
    const registrations = await this.getRegistrationsForEvent('claim.status.change');

    for (const registration of registrations) {
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
    const payloadStr = JSON.stringify(payload);
    return crypto.createHmac('sha256', secret).update(payloadStr).digest('base64');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}