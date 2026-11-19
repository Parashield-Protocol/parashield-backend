import { EventEmitter } from 'events';
import { ForbiddenException } from '@nestjs/common';
import { StatusEventsService } from './status-events.service';

describe('StatusEventsService cross-instance Redis pub/sub (#869)', () => {
  function createMockRedisPair() {
    const channels = new EventEmitter();
    const createClient = () => {
      const subEmitter = new EventEmitter();
      return {
        publish: jest.fn(async (channel: string, message: string) => {
          channels.emit(channel, message);
          return 1;
        }),
        duplicate: jest.fn(() => {
          const dup: any = {
            on: (ev: string, cb: (...args: any[]) => void) => {
              subEmitter.on(ev, cb);
              return dup;
            },
            subscribe: jest.fn(async (...chs: string[]) => {
              for (const ch of chs) {
                channels.on(ch, (msg: string) => subEmitter.emit('message', ch, msg));
              }
            }),
            unsubscribe: jest.fn(async () => {}),
            disconnect: jest.fn(),
          };
          return dup;
        }),
      };
    };
    return { instanceARedis: createClient(), instanceBRedis: createClient() };
  }

  it('broadcasts events published by instance A to instance B and ignores self-published events', async () => {
    const { instanceARedis, instanceBRedis } = createMockRedisPair();
    const instanceA = new StatusEventsService(instanceARedis as any);
    const instanceB = new StatusEventsService(instanceBRedis as any);

    await instanceA.onModuleInit();
    await instanceB.onModuleInit();

    const receivedOnA: any[] = [];
    const receivedOnB: any[] = [];
    const unsubA = instanceA.subscribeToPolicyStatus('policy-1', (ev) => receivedOnA.push(ev));
    const unsubB = instanceB.subscribeToPolicyStatus('policy-1', (ev) => receivedOnB.push(ev));

    instanceA.emitPolicyStatusChange('policy-1', 'CLAIMED');

    // Instance A gets 1 local emission (self-published Redis echo is ignored)
    expect(receivedOnA).toHaveLength(1);
    // Instance B receives the remote Redis broadcast
    expect(receivedOnB).toHaveLength(1);
    expect(receivedOnB[0]).toMatchObject({ policyId: 'policy-1', status: 'CLAIMED' });

    unsubA();
    unsubB();

    await instanceA.onModuleDestroy();
    await instanceB.onModuleDestroy();
  });

  it('handles malformed Redis pub/sub messages gracefully without throwing', async () => {
    const { instanceARedis } = createMockRedisPair();
    const svc = new StatusEventsService(instanceARedis as any);
    await svc.onModuleInit();

    expect(() => (svc as any).handleRemoteEvent('not-valid-json{{{')).not.toThrow();
    expect(() => (svc as any).handleRemoteOracleKeyEvent('not-valid-json{{{')).not.toThrow();

    await svc.onModuleDestroy();
  });

  it('buffers events during async authorization and flushes once authorized', async () => {
    let resolvePolicy!: (val: any) => void;
    const mockPrisma = {
      policy: {
        findUnique: jest.fn(
          () =>
            new Promise((resolve) => {
              resolvePolicy = resolve;
            }),
        ),
      },
    };

    const svc = new StatusEventsService(undefined, mockPrisma as any);
    const received: any[] = [];

    const unsub = svc.subscribeToPolicyStatus('policy-async', 'GWALLET_OWNER', (ev) => {
      received.push(ev);
    });

    // Emit while authorization is still pending
    svc.emitPolicyStatusChange('policy-async', 'PROCESSING');
    expect(received).toHaveLength(0);

    // Resolve policy ownership check
    resolvePolicy({ policyholder: 'GWALLET_OWNER' });
    await Promise.resolve();
    await Promise.resolve();

    expect(received).toHaveLength(1);
    expect(received[0].status).toBe('PROCESSING');
    unsub();
  });

  it('rejects unauthorized subscriptions synchronously when owner is cached and cleans up async unauthorized ones', async () => {
    const svcCached = new StatusEventsService();
    svcCached.setPolicyOwner('policy-owned', 'GOWNER');
    expect(() =>
      svcCached.subscribeToPolicyStatus('policy-owned', 'GATTACKER', () => {}),
    ).toThrow(ForbiddenException);

    const mockPrisma = {
      policy: {
        findUnique: jest.fn().mockResolvedValue({ policyholder: 'GOWNER' }),
      },
    };
    const svcAsync = new StatusEventsService(undefined, mockPrisma as any);
    const received: any[] = [];
    svcAsync.subscribeToPolicyStatus('policy-2', 'GATTACKER', (ev) => received.push(ev));

    // Wait for async findUnique rejection of unauthorized wallet
    await Promise.resolve();
    await Promise.resolve();

    svcAsync.emitPolicyStatusChange('policy-2', 'CLAIMED');
    expect(received).toHaveLength(0);
  });

  describe('#857 — policyOwners cache is bounded with LRU eviction', () => {
    const owners = (svc: StatusEventsService) => (svc as any).policyOwners as Map<string, string>;
    const withCacheSize = (size: number) =>
      new StatusEventsService(undefined, undefined, { get: (k: string) => (k === 'STATUS_EVENTS_OWNER_CACHE_SIZE' ? String(size) : undefined) } as any);

    it('evicts the least-recently-used owner once the cache exceeds its max size', () => {
      const svc = withCacheSize(2);
      svc.setPolicyOwner('p1', 'G1');
      svc.setPolicyOwner('p2', 'G2');
      svc.setPolicyOwner('p3', 'G3');

      expect(owners(svc).size).toBe(2);
      expect(owners(svc).has('p1')).toBe(false);
      expect([...owners(svc).keys()]).toEqual(['p2', 'p3']);
    });

    it('refreshes recency on a subscription cache hit so hot policies survive eviction', () => {
      const svc = withCacheSize(2);
      svc.setPolicyOwner('p1', 'G1');
      svc.setPolicyOwner('p2', 'G2');

      const unsub = svc.subscribeToPolicyStatus('p1', 'G1', () => {});
      svc.setPolicyOwner('p3', 'G3');

      expect(owners(svc).has('p1')).toBe(true);
      expect(owners(svc).has('p2')).toBe(false);
      unsub();
    });

    it('falls back to the default size when the configured value is invalid', () => {
      const svc = new StatusEventsService(undefined, undefined, { get: () => 'not-a-number' } as any);
      expect((svc as any).policyOwnerCacheSize).toBe(10_000);
    });
  });
});
