import { PolicyService } from './policy.service';

/**
 * #816 — search results carry each policy's real claim count instead of a
 * hard-coded 0, on both the full-text path and the ILIKE fallback.
 */
describe('PolicyService.searchPolicies claimsCount (#816)', () => {
  const row = {
    id: 'pol-1',
    productId: 'prod-1',
    policyholder: 'GHOLDER',
    coverageXlm: '1000',
    premiumPaid: '50',
    oracleKey: 'rain:lagos',
    startTime: new Date(1700000000000),
    endTime: new Date(1702592000000),
    status: 'ACTIVE',
  };

  function build(prisma: any) {
    return new PolicyService({} as any, prisma, {} as any, {} as any, {} as any);
  }

  it('selects a per-policy claim count in the full-text query and returns it', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ ...row, claimsCount: 3, relevance: 0.5 }])
        .mockResolvedValueOnce([{ count: 1 }]),
    };

    const result = await build(prisma).searchPolicies('lagos');

    expect(result.data[0].claimsCount).toBe(3);
    const sqlText = prisma.$queryRaw.mock.calls[0][0].join(' ');
    expect(sqlText).toContain('FROM "Claim" c WHERE c."policyId" = p.id');
  });

  it('uses the Prisma _count on the fallback path', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('tsvector unavailable')),
      policy: {
        findMany: jest.fn().mockResolvedValue([
          { ...row, coverageXlm: { toString: () => '1000' }, premiumPaid: { toString: () => '50' }, _count: { claims: 2 } },
        ]),
        count: jest.fn().mockResolvedValue(1),
      },
    };

    const result = await build(prisma).searchPolicies('lagos');

    expect(result.data[0].claimsCount).toBe(2);
    expect(prisma.policy.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ include: { _count: { select: { claims: true } } } }),
    );
  });
});
