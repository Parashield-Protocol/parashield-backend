import { StatusEventsService } from './common/events/status-events.service';
import { OracleWorker } from './oracle/oracle.worker';
import { ClaimsWorker } from './claims/claims.worker';
import { PrismaService } from './prisma/prisma.service';

describe('Parashield issues #861, #862, #863, #864', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('#861 — flushes buffered events on Prisma verification error', async () => {
    const prismaMock = {
      policy: {
        findUnique: jest.fn().mockRejectedValue(new Error('DB connection lost')),
      },
    };
    const service = new StatusEventsService(undefined, prismaMock as any);
    const received: any[] = [];

    const unsub = service.subscribeToPolicyStatus(
      'policy-err-1',
      (ev) => received.push(ev),
      'GWALLET123',
    );

    // Emit while async verification is still pending
    service.emitPolicyStatusChange('policy-err-1', 'CLAIMED');

    // Wait for rejected promise handler to run
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ policyId: 'policy-err-1', status: 'CLAIMED' });
    unsub();
  });

  it('#862 — fetchWithRetry skips retry when circuit breaker is open', async () => {
    const worker = new OracleWorker(
      {} as any,
      {} as any,
      {} as any,
      { runWithLock: jest.fn() } as any,
    );
    const sleepSpy = jest.spyOn(worker as any, 'sleep').mockResolvedValue(undefined);
    const fetchFn = jest
      .fn()
      .mockRejectedValue(new Error('External service "OpenMeteo" is temporarily unavailable (circuit open)'));

    const result = await (worker as any).fetchWithRetry(fetchFn);

    expect(result).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('#863 — loadActiveProductsMap passes skipCache: true to getActiveProducts', async () => {
    const getActiveProducts = jest.fn().mockResolvedValue({
      data: [{ id: 'prod-1', name: 'Rain' }],
      total: 1,
    });
    const worker = new ClaimsWorker(
      {} as any,
      {} as any,
      { getActiveProducts } as any,
      {} as any,
      { runWithLock: jest.fn() } as any,
    );

    const map = await (worker as any).loadActiveProductsMap();

    expect(getActiveProducts).toHaveBeenCalledWith(1, 100, { skipCache: true });
    expect(map.get('prod-1')).toMatchObject({ id: 'prod-1', name: 'Rain' });
  });

  it('#864 — PrismaService Proxy throws clear error when client is uninitialized', () => {
    const prisma = new PrismaService();
    (prisma as any).client = undefined;

    expect(() => (prisma as any).policy).toThrow('PrismaService not initialized');
  });
});
