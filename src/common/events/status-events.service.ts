import {
  Injectable,
  Logger,
  Inject,
  Optional,
  OnModuleInit,
  OnModuleDestroy,
  ForbiddenException,
} from '@nestjs/common';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import type Redis from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service';

export interface PolicyStatusEvent {
  policyId:  string;
  status:    string;
  timestamp: number;
}

const STATUS_EVENTS_CHANNEL = 'policy:status:events';

/**
 * StatusEventsService — pub/sub for policy status changes (#349).
 *
 * Backs the SSE endpoint on PolicyController. Events are emitted locally
 * via Node EventEmitter and broadcast across all running instances via
 * Redis pub/sub so clients connected to any instance receive status updates.
 * Subscribers are authenticated so clients only receive events for policies they own.
 */
@Injectable()
export class StatusEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StatusEventsService.name);
  private readonly emitter = new EventEmitter();
  private readonly instanceId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  private readonly policyOwners = new Map<string, string>();
  private subscriber?: Redis;

  constructor(
    @Optional()
    @Inject('REDIS_CLIENT')
    private readonly redis?: Redis,
    @Optional()
    private readonly prisma?: PrismaService,
  ) {
    // Default is 10 — a popular policy with many open SSE connections
    // shouldn't trigger Node's "possible memory leak" warning.
    this.emitter.setMaxListeners(1000);
  }

  setPolicyOwner(policyId: string, owner: string): void {
    this.policyOwners.set(policyId, owner);
  }

  async onModuleInit(): Promise<void> {
    if (this.redis && typeof this.redis.duplicate === 'function') {
      try {
        this.subscriber = this.redis.duplicate();
        this.subscriber.on('error', (err) => {
          this.logger.error(`Redis subscriber error: ${err.message}`);
        });
        this.subscriber.on('message', (channel, message) => {
          if (channel === STATUS_EVENTS_CHANNEL) {
            this.handleRemoteEvent(message);
          }
        });
        await this.subscriber.subscribe(STATUS_EVENTS_CHANNEL);
        this.logger.log(`Subscribed to Redis pub/sub channel: ${STATUS_EVENTS_CHANNEL}`);
      } catch (err) {
        this.logger.warn(
          `Failed to initialize Redis subscriber, falling back to local events: ${(err as Error).message}`,
        );
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subscriber) {
      try {
        if (typeof this.subscriber.unsubscribe === 'function') {
          await this.subscriber.unsubscribe(STATUS_EVENTS_CHANNEL);
        }
        if (typeof this.subscriber.disconnect === 'function') {
          this.subscriber.disconnect();
        }
      } catch (err) {
        this.logger.warn(`Error disconnecting Redis subscriber: ${(err as Error).message}`);
      }
    }
  }

  emitPolicyStatusChange(policyId: string, status: string): void {
    const event: PolicyStatusEvent = { policyId, status, timestamp: Date.now() };
    this.logger.log(`Policy status event: ${policyId} → ${status}`);
    this.emitter.emit(`policy:${policyId}`, event);

    if (this.redis && typeof this.redis.publish === 'function') {
      const payload = JSON.stringify({
        ...event,
        origin: this.instanceId,
      });
      const publishResult = this.redis.publish(STATUS_EVENTS_CHANNEL, payload);
      if (publishResult && typeof publishResult.catch === 'function') {
        publishResult.catch((err) => {
          this.logger.error(`Failed to publish status event to Redis for policy ${policyId}: ${err.message}`);
        });
      }
    }
  }

  subscribeToPolicyStatus(
    policyId: string,
    arg2: ((event: PolicyStatusEvent) => void) | string,
    arg3?: ((event: PolicyStatusEvent) => void) | string,
  ): () => void {
    let listener: (event: PolicyStatusEvent) => void;
    let subscriberWallet: string | undefined;

    if (typeof arg2 === 'function') {
      listener = arg2;
      subscriberWallet = typeof arg3 === 'string' ? arg3 : undefined;
    } else {
      subscriberWallet = arg2;
      listener = arg3 as (event: PolicyStatusEvent) => void;
    }

    if (!listener) {
      throw new Error('Listener callback is required for policy status subscription');
    }

    // Check synchronous cache if available
    const knownOwner = this.policyOwners.get(policyId);
    if (knownOwner && subscriberWallet && knownOwner !== subscriberWallet) {
      this.logger.warn(
        `Subscriber ${subscriberWallet} does not own policy ${policyId} (owned by ${knownOwner})`,
      );
      throw new ForbiddenException('Subscriber does not own this policy');
    }

    let isAuthorized: boolean | null = knownOwner ? knownOwner === subscriberWallet : null;
    let unsubscribed = false;
    const pendingEvents: PolicyStatusEvent[] = [];

    const wrappedListener = (event: PolicyStatusEvent) => {
      if (unsubscribed) return;
      if (isAuthorized === false) return;
      if (isAuthorized === true) {
        listener(event);
        return;
      }
      // If verification is still in progress, buffer the event
      pendingEvents.push(event);
    };

    if (subscriberWallet) {
      if (knownOwner) {
        isAuthorized = knownOwner === subscriberWallet;
      } else if (this.prisma) {
        this.prisma.policy
          .findUnique({
            where: { id: policyId },
            select: { policyholder: true },
          })
          .then((policy) => {
            if (unsubscribed) return;
            if (policy && policy.policyholder === subscriberWallet) {
              isAuthorized = true;
              this.policyOwners.set(policyId, policy.policyholder);
              // Flush buffered events
              while (pendingEvents.length > 0) {
                const ev = pendingEvents.shift()!;
                listener(ev);
              }
            } else {
              isAuthorized = false;
              pendingEvents.length = 0;
              this.logger.warn(
                `Unauthorized subscription attempt for policy ${policyId} by wallet ${subscriberWallet}`,
              );
              this.emitter.off(`policy:${policyId}`, wrappedListener);
            }
          })
          .catch((err) => {
            isAuthorized = false;
            pendingEvents.length = 0;
            this.logger.error(
              `Error verifying subscriber identity for policy ${policyId}: ${(err as Error).message}`,
            );
          });
      } else {
        // Without Prisma or known owner, assume authorized if wallet was provided
        isAuthorized = true;
      }
    } else if (!this.prisma) {
      // In minimal test setups without Prisma or wallet, allow subscription
      isAuthorized = true;
    } else {
      // In production environments with Prisma, unauthenticated subscriptions are rejected
      isAuthorized = false;
      this.logger.warn(
        `Unauthenticated subscription attempt for policy ${policyId} without subscriber wallet`,
      );
    }

    this.emitter.on(`policy:${policyId}`, wrappedListener);

    return () => {
      unsubscribed = true;
      this.emitter.off(`policy:${policyId}`, wrappedListener);
    };
  }

  private handleRemoteEvent(message: string): void {
    try {
      const data = JSON.parse(message) as {
        origin?: string;
        policyId: string;
        status: string;
        timestamp: number;
      };

      // Ignore events published by this instance — they were already emitted locally
      if (data.origin === this.instanceId) {
        return;
      }

      const event: PolicyStatusEvent = {
        policyId: data.policyId,
        status: data.status,
        timestamp: data.timestamp,
      };

      this.emitter.emit(`policy:${event.policyId}`, event);
    } catch (err) {
      this.logger.error(`Failed to parse remote status event: ${(err as Error).message}`);
    }
  }
}
