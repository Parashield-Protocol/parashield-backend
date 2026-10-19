import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Read every mutable input needed to begin claim evaluation from one
 * PostgreSQL REPEATABLE READ snapshot. A product/oracle update committed while
 * this callback is running cannot be mixed with the policy state read first.
 */
export async function readClaimEvaluationSnapshot(
  prisma: PrismaClient,
  policyId: string,
) {
  return prisma.$transaction(
    async (tx) => {
      const policy = await tx.policy.findUnique({ where: { id: policyId } });
      if (!policy) return { policy: null, reading: null };

      const reading = await tx.oracleReading.findFirst({
        where: { key: policy.oracleKey },
        orderBy: { submittedAt: 'desc' },
      });
      return { policy, reading };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
