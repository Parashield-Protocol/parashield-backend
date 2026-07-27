import { ClaimsWorker } from './claims.worker';
import { ClaimsService } from './claims.service';
import { PrismaService } from '../prisma/prisma.service';
import { PolicyService } from '../policy/policy.service';

describe('ClaimsWorker', () => {
  let worker: ClaimsWorker;
  let mockClaims: jest.Mocked<Pick<ClaimsService, 'autoProcess'>>;
  let mockPrisma: {
    policy: { findMany: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  };
  let mockPolicyService: { getActiveProducts: jest.Mock };

  function policy(id: string, overrides: Partial<{ status: string }> = {}) {
    return {
      id,
      policyholder: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ',
      endTime: new Date(),
      status: overrides.status ?? 'ACTIVE',
    };
  }

  beforeEach(() => {
    mockClaims = { autoProcess: jest.fn() };
    mockPrisma = {
      policy: {
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockPolicyService = { getActiveProducts: jest.fn().mockResolvedValue([]) };
    worker = new ClaimsWorker(
      mockClaims as unknown as ClaimsService,
      mockPrisma as unknown as PrismaService,
      mockPolicyService as unknown as PolicyService,
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
    mockPolicyService.getActiveProducts.mockResolvedValue([{ id: 'prod1', name: 'Product 1' }]);

    await worker.processActivePolicies();

    expect(mockPolicyService.getActiveProducts).toHaveBeenCalledTimes(1);
    expect(mockClaims.autoProcess).toHaveBeenCalledWith('p1', expect.any(Map));
    expect(mockPrisma.policy.update).not.toHaveBeenCalled();
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
});
