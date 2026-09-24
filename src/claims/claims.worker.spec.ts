import type Redis from 'ioredis';
import { ClaimsWorker } from './claims.worker';
import { ClaimsService } from './claims.service';
import { PrismaService } from '../prisma/prisma.service';
import { PolicyService } from '../policy/policy.service';

describe('ClaimsWorker', () => {
  let worker: ClaimsWorker;
  let mockClaims: jest.Mocked<Pick<ClaimsService, 'autoProcess' | 'recoverStuckProcessingPolicies'>>;
  let mockPrisma: {
    policy: { findMany: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  };
  let mockPolicyService: { getActiveProducts: jest.Mock };
  let mockRedis: { set: jest.Mock; mget: jest.Mock };

  function policy(id: string, overrides: Partial<{ status: string }> = {}) {
    return {
      id,
      policyholder: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ',
      endTime: new Date(),
      status: overrides.status ?? 'ACTIVE',
    };
  }

  beforeEach(() => {
    mockClaims = {
      autoProcess: jest.fn(),
      recoverStuckProcessingPolicies: jest.fn().mockResolvedValue({
        scanned: 0, revertedToActive: 0, markedClaimed: 0, needsManualReview: 0, skipped: 0,
      }),
    };
    mockPrisma = {
      policy: {
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockPolicyService = { getActiveProducts: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 100 }) };
    mockRedis = { set: jest.fn().mockResolvedValue('OK'), mget: jest.fn().mockResolvedValue([]) };
    worker = new ClaimsWorker(
      mockClaims as unknown as ClaimsService,
      mockPrisma as unknown as PrismaService,
      mockPolicyService as unknown as PolicyService,
      mockRedis as unknown as Redis,
    );
  });

  it('does nothing when no policies are expiring', async () => {
    mockPrisma.policy.findMany.mockResolvedValue([]);

    await worker.processActivePolicies();

    expect(mockClaims.autoProcess).not.toHaveBeenCalled();
    expect(mockPrisma.policy.update).not.toHaveBeenCalled();
  });

  it('scans only ACTIVE policies expiring within the lookahead window', async () => {
    mockPrisma.policy.findMany.mockResolvedValue([]);

    await worker.processActivePolicies();

    expect(mockPrisma.policy.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE', endTime: expect.objectContaining({ lte: expect.any(Date) }) }),
      }),
    );
  });

  it('auto-processes each expiring policy with pre-fetched productsMap (#266)', async () => {
    mockPrisma.policy.findMany.mockResolvedValue([policy('p1')]);
    mockClaims.autoProcess.mockResolvedValue('Paid');
    mockPolicyService.getActiveProducts.mockResolvedValue({ data: [{ id: 'prod1', name: 'Product 1' }], total: 1, page: 1, limit: 100 });

    await worker.processActivePolicies();

    expect(mockPolicyService.getActiveProducts).toHaveBeenCalledTimes(1);
    expect(mockClaims.autoProcess).toHaveBeenCalledWith('p1', expect.any(Map));
    const productsMap = mockClaims.autoProcess.mock.calls[0][1] as Map<string, unknown>;
    expect(productsMap.get('prod1')).toEqual({ id: 'prod1', name: 'Product 1' });
    expect(mockPrisma.policy.update).not.toHaveBeenCalled();
  });

  it('pages through the whole active product catalogue for productsMap', async () => {
    mockPrisma.policy.findMany.mockResolvedValue([policy('p1')]);
    mockClaims.autoProcess.mockResolvedValue('Paid');
    const firstPage = Array.from({ length: 100 }, (_, i) => ({ id: `prod${i}` }));
    mockPolicyService.getActiveProducts
      .mockResolvedValueOnce({ data: firstPage, total: 101, page: 1, limit: 100 })
      .mockResolvedValueOnce({ data: [{ id: 'prod100' }], total: 101, page: 2, limit: 100 });

    await worker.processActivePolicies();

    expect(mockPolicyService.getActiveProducts).toHaveBeenNthCalledWith(1, 1, 100);
    expect(mockPolicyService.getActiveProducts).toHaveBeenNthCalledWith(2, 2, 100);
    const productsMap = mockClaims.autoProcess.mock.calls[0][1] as Map<string, unknown>;
    expect(productsMap.size).toBe(101);
  });

  it('marks a policy EXPIRED when auto-processing does not result in a payout', async () => {
    mockPrisma.policy.findMany.mockResolvedValue([policy('p1')]);
    mockClaims.autoProcess.mockResolvedValue('Rejected');

    await worker.processActivePolicies();

    // #260 — guarded via updateMany({ where: { id, status: expected } }) rather
    // than an unconditional update({ where: { id } }).
    expect(mockPrisma.policy.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', status: 'ACTIVE' },
      data: { status: 'EXPIRED' },
    });
  });

  it('continues processing the rest of the batch when one policy fails', async () => {
    mockPrisma.policy.findMany.mockResolvedValue([policy('p1'), policy('p2')]);
    mockClaims.autoProcess.mockImplementation(async (id: string) => {
      if (id === 'p1') throw new Error('Soroban RPC timeout');
      return 'Paid';
    });

    await expect(worker.processActivePolicies()).resolves.toBeUndefined();

    expect(mockClaims.autoProcess).toHaveBeenCalledWith('p1', expect.any(Map));
    expect(mockClaims.autoProcess).toHaveBeenCalledWith('p2', expect.any(Map));
    // p1's failure must not mark it EXPIRED, and p2's "Paid" also skips the update.
    expect(mockPrisma.policy.update).not.toHaveBeenCalled();
  });

  // #264 — the worker's in-memory policy.status snapshot is always 'ACTIVE'
  // (guaranteed by the findMany filter) and is never re-read after
  // autoProcess resolves, which can take seconds (oracle lookup + Stellar
  // RPC). If a concurrent path (e.g. a payout completing, or a cancellation)
  // moves the policy to CLAIMED/CANCELLED during that window, the guarded
  // updateMany({ where: { id, status: 'ACTIVE' } }) added for #260 must find
  // zero matching rows and must NOT clobber the real status back to EXPIRED.
  it('does not clobber a policy that moved to CLAIMED/CANCELLED underneath the worker (#264)', async () => {
    mockPrisma.policy.findMany.mockResolvedValue([policy('p1')]);
    mockClaims.autoProcess.mockResolvedValue('PolicyNotActive');
    mockPrisma.policy.updateMany.mockResolvedValue({ count: 0 });

    await expect(worker.processActivePolicies()).resolves.toBeUndefined();

    expect(mockPrisma.policy.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', status: 'ACTIVE' },
      data: { status: 'EXPIRED' },
    });
    // The guard's WHERE clause (status: 'ACTIVE') means a real CLAIMED/CANCELLED
    // row simply doesn't match and updateMany affects 0 rows — asserted above by
    // resolving mockResolvedValue({ count: 0 }) without the call throwing.
    expect(mockPrisma.policy.update).not.toHaveBeenCalled();
  });

  // #486 — stuck PROCESSING policies are recovered before the ACTIVE scan so
  // that anything reverted to ACTIVE is picked up in the same tick.
  it('recovers stuck PROCESSING policies before scanning for expiring ones', async () => {
    mockPrisma.policy.findMany.mockResolvedValue([]);

    await worker.processActivePolicies();

    expect(mockClaims.recoverStuckProcessingPolicies).toHaveBeenCalledTimes(1);
    expect(mockClaims.recoverStuckProcessingPolicies.mock.invocationCallOrder[0])
      .toBeLessThan(mockPrisma.policy.findMany.mock.invocationCallOrder[0]);
  });

  it('still runs the regular scan when stuck-policy recovery throws', async () => {
    mockClaims.recoverStuckProcessingPolicies.mockRejectedValue(new Error('db down'));
    mockPrisma.policy.findMany.mockResolvedValue([policy('p1')]);
    mockClaims.autoProcess.mockResolvedValue('Paid');

    await expect(worker.processActivePolicies()).resolves.toBeUndefined();

    expect(mockClaims.autoProcess).toHaveBeenCalledWith('p1', expect.any(Map));
  });
});
