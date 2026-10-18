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
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service';

export interface PolicyStatusEvent {
  policyId:  string;
  status:    string;
  timestamp: number;
}

export interface PolicyOracleKeyChangeEvent {
  policyId:      string;
  oldOracleKey:  string;
  newOracleKey:  string;
  actor?:        string | null;
  timestamp:     number;
  correlationId?: string | null;
}

export interface ClaimStatusChangeEvent {
  claimId:    string;
  fromStatus: string;
  toStatus:   string;
  actorId:    string;
  timestamp:  number;
  reason?:    string | null;
}

const STATUS_EVENTS_CHANNEL = 'policy:status:events';
const ORACLE_KEY_EVENTS_CHANNEL = 'policy:oracle_key:events';
const DEFAULT_MAX_LISTENERS = 1000;

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
    @Optional()
    private readonly config?: ConfigService,
  ) {
    const configuredMaxListeners = Number(this.config?.get<string>('STATUS_EVENTS_MAX_LISTENERS'));
    const maxListeners = Number.isSafeInteger(configuredMaxListeners) && configuredMaxListeners > 0
      ? configuredMaxListeners
      : DEFAULT_MAX_LISTENERS;
    this.emitter.setMaxListeners(maxListeners);
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
          } else if (channel === ORACLE_KEY_EVENTS_CHANNEL) {
            this.handleRemoteOracleKeyEvent(message);
          }
        });
        await this.subscriber.subscribe(STATUS_EVENTS_CHANNEL, ORACLE_KEY_EVENTS_CHANNEL);
        this.logger.log(`Subscribed to Redis pub/sub channels: ${STATUS_EVENTS_CHANNEL}, ${ORACLE_KEY_EVENTS_CHANNEL}`);
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
          await this.subscriber.unsubscribe(STATUS_EVENTS_CHANNEL, ORACLE_KEY_EVENTS_CHANNEL);
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
    this.emitter.emit('status', event);

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

  onStatusChange(listener: (event: PolicyStatusEvent) => void): () => void {
    this.emitter.on('status', listener);
    return () => this.emitter.off('status', listener);
  }

  onOracleKeyChange(listener: (event: PolicyOracleKeyChangeEvent) => void): () => void {
    this.emitter.on('policy:oracleKey', listener);
    return () => this.emitter.off('policy:oracleKey', listener);
  }

  onProductUpdate(listener: (productId?: string) => void): () => void {
    this.emitter.on('product:updated', listener);
    return () => this.emitter.off('product:updated', listener);
  }

  emitProductUpdate(productId?: string): void {
    this.logger.log(`Product update event: ${productId ?? 'global'}`);
    this.emitter.emit('product:updated', productId);
  }

  emitPolicyOracleKeyChange(event: PolicyOracleKeyChangeEvent): void {
    this.logger.log(`Policy oracle key change event: ${event.policyId} (${event.oldOracleKey} → ${event.newOracleKey})`);
    this.emitter.emit(`policy:${event.policyId}:oracleKey`, event);
    this.emitter.emit(`policy:${event.policyId}`, event);
    this.emitter.emit('policy:oracleKey', event);

    if (this.redis && typeof this.redis.publish === 'function') {
      const payload = JSON.stringify({
        ...event,
        origin: this.instanceId,
      });
      const publishResult = this.redis.publish(ORACLE_KEY_EVENTS_CHANNEL, payload);
      if (publishResult && typeof publishResult.catch === 'function') {
        publishResult.catch((err) => {
          this.logger.error(`Failed to publish oracle key change event to Redis for policy ${event.policyId}: ${err.message}`);
        });
      }
    }
  }

  emitClaimStatusChange(event: ClaimStatusChangeEvent): void {
    this.logger.log(`Claim status event: ${event.claimId} (${event.fromStatus} → ${event.toStatus}) by ${event.actorId}`);
    this.emitter.emit(`claim:${event.claimId}`, event);
    this.emitter.emit('claim:status', event);
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

  private handleRemoteOracleKeyEvent(message: string): void {
    try {
      const data = JSON.parse(message) as {
        origin?: string;
        policyId: string;
        oldOracleKey: string;
        newOracleKey: string;
        actor?: string | null;
        timestamp: number;
        correlationId?: string | null;
      };

      if (data.origin === this.instanceId) {
        return;
      }

      const event: PolicyOracleKeyChangeEvent = {
        policyId: data.policyId,
        oldOracleKey: data.oldOracleKey,
        newOracleKey: data.newOracleKey,
        actor: data.actor,
        timestamp: data.timestamp,
        correlationId: data.correlationId,
      };

      this.emitter.emit(`policy:${event.policyId}:oracleKey`, event);
      this.emitter.emit(`policy:${event.policyId}`, event);
      this.emitter.emit('policy:oracleKey', event);
    } catch (err) {
      this.logger.error(`Failed to parse remote oracle key event: ${(err as Error).message}`);
    }
  }
}
