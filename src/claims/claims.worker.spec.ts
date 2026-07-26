import { ClaimsWorker } from './claims.worker';
import { ClaimsService } from './claims.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ClaimsWorker', () => {
  let worker: ClaimsWorker;
  let mockClaims: jest.Mocked<Pick<ClaimsService, 'autoProcess'>>;
  let mockPrisma: {
    policy: { findMany: jest.Mock; update: jest.Mock };
  };

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
      },
    };
    worker = new ClaimsWorker(mockClaims as unknown as ClaimsService, mockPrisma as unknown as PrismaService);
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

  it('auto-processes each expiring policy and leaves a "Paid" result untouched', async () => {
    mockPrisma.policy.findMany.mockResolvedValue([policy('p1')]);
    mockClaims.autoProcess.mockResolvedValue('Paid');

    await worker.processActivePolicies();

    expect(mockClaims.autoProcess).toHaveBeenCalledWith('p1');
    expect(mockPrisma.policy.update).not.toHaveBeenCalled();
  });

  it('marks a policy EXPIRED when auto-processing does not result in a payout', async () => {
    mockPrisma.policy.findMany.mockResolvedValue([policy('p1')]);
    mockClaims.autoProcess.mockResolvedValue('Rejected');

    await worker.processActivePolicies();

    expect(mockPrisma.policy.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
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

    expect(mockClaims.autoProcess).toHaveBeenCalledWith('p1');
    expect(mockClaims.autoProcess).toHaveBeenCalledWith('p2');
    // p1's failure must not mark it EXPIRED, and p2's "Paid" also skips the update.
    expect(mockPrisma.policy.update).not.toHaveBeenCalled();
  });
});
