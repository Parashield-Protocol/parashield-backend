import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';

export interface PolicyStatusEvent {
  policyId:  string;
  status:    string;
  timestamp: number;
}

/**
 * StatusEventsService — in-process pub/sub for policy status changes (#349).
 *
 * Backs the SSE endpoint on PolicyController; this is intentionally a plain
 * Node EventEmitter rather than a message broker. That means subscribers
 * only see events emitted by the same server process/instance they're
 * connected to -- fine for a single-instance deployment, but a multi-instance
 * deployment would need this backed by Redis pub/sub (already a dependency
 * elsewhere in this project) for a client connected to instance A to see a
 * status change made via instance B. Noted as a follow-up, not implemented
 * here to keep this fix scoped to the transport itself.
 */
@Injectable()
export class StatusEventsService {
  private readonly logger = new Logger(StatusEventsService.name);
  private readonly emitter = new EventEmitter();

  constructor() {
    // Default is 10 — a popular policy with many open SSE connections
    // shouldn't trigger Node's "possible memory leak" warning.
    this.emitter.setMaxListeners(1000);
  }

  emitPolicyStatusChange(policyId: string, status: string): void {
    const event: PolicyStatusEvent = { policyId, status, timestamp: Date.now() };
    this.logger.log(`Policy status event: ${policyId} → ${status}`);
    this.emitter.emit(`policy:${policyId}`, event);
  }

  subscribeToPolicyStatus(policyId: string, listener: (event: PolicyStatusEvent) => void): () => void {
    this.emitter.on(`policy:${policyId}`, listener);
    return () => this.emitter.off(`policy:${policyId}`, listener);
  }
}
