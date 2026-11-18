import { ClaimsService } from './claims.service';

// #791 — a claim status query must not re-run the policy's claim COUNT
// aggregate when the policy-state cache already holds a fresh count.

function makeClaimRow() {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'claim-1',
    policyId: 'policy-1',
    claimant: 'GCLAIMANT',
    coverageAmount: { toString: () => '100' },
    payoutAmount: null,
    triggerMet: false,
    status: 'PENDING',
    submittedAt: now,
    processedAt: null,
    txHash: null,
    createdAt: now,
    policy: {
      id: 'policy-1',
      productId: 'product-1',
      policyholder: 'GCLAIMANT',
      coverageXlm: { toString: () => '100' },
      premiumPaid: { toString: () => '5' },
      oracleKey: 'rainfall:0,0:2026-01',
      startTime: now,
      endTime: now,
      status: 'ACTIVE',
    },
  };
}

function makeService(policyStateCache?: { getDerivedPolicyState: jest.Mock }) {
  const prisma = {
    claim: {
      findUnique: jest.fn().mockResolvedValue(makeClaimRow()),
      count: jest.fn().mockResolvedValue(7),
    },
  };
  const service = new ClaimsService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    prisma as any,
    {} as any,
    {} as any,
    policyStateCache as any,
  );
  return { service, prisma };
}

describe('ClaimsService.getClaim claim aggregates (#791)', () => {
  it('uses the cached claim count instead of a COUNT query', async () => {
    const cache = {
      getDerivedPolicyState: jest.fn().mockResolvedValue({ claimsCount: 3 }),
    };
    const { service, prisma } = makeService(cache);

    const result = await service.getClaim('claim-1');

    expect(result?.policy?.claimsCount).toBe(3);
    expect(prisma.claim.count).not.toHaveBeenCalled();
    expect(prisma.claim.findUnique).toHaveBeenCalledWith({
      where: { id: 'claim-1' },
      include: { policy: true },
    });
  });

  it('reflects a fresh count after the cache is invalidated', async () => {
    const cache = {
      getDerivedPolicyState: jest
        .fn()
        .mockResolvedValueOnce({ claimsCount: 1 })
        .mockResolvedValueOnce({ claimsCount: 2 }),
    };
    const { service } = makeService(cache);

    expect((await service.getClaim('claim-1'))?.policy?.claimsCount).toBe(1);
    expect((await service.getClaim('claim-1'))?.policy?.claimsCount).toBe(2);
  });

  it('counts directly when no policy-state cache is configured', async () => {
    const { service, prisma } = makeService(undefined);

    const result = await service.getClaim('claim-1');

    expect(result?.policy?.claimsCount).toBe(7);
    expect(prisma.claim.count).toHaveBeenCalledWith({ where: { policyId: 'policy-1' } });
  });

  it('falls back to a direct count when the cache has no state for the policy', async () => {
    const cache = { getDerivedPolicyState: jest.fn().mockResolvedValue(null) };
    const { service, prisma } = makeService(cache);

    const result = await service.getClaim('claim-1');

    expect(result?.policy?.claimsCount).toBe(7);
    expect(prisma.claim.count).toHaveBeenCalledTimes(1);
  });
});
