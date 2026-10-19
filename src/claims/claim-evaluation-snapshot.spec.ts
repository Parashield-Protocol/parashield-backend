import { Prisma } from '@prisma/client';
import { readClaimEvaluationSnapshot } from './claim-evaluation-snapshot';

describe('readClaimEvaluationSnapshot', () => {
  it('reads policy and oracle state in one repeatable-read transaction', async () => {
    const policy = { id: 'policy-1', oracleKey: 'rainfall:old' };
    const reading = { id: 'reading-1', key: 'rainfall:old', value: 10n };
    const transactionClient = {
      policy: { findUnique: jest.fn().mockResolvedValue(policy) },
      oracleReading: { findFirst: jest.fn().mockResolvedValue(reading) },
    };
    const prisma = {
      $transaction: jest.fn(async (callback) => callback(transactionClient)),
    } as any;

    await expect(readClaimEvaluationSnapshot(prisma, policy.id)).resolves.toEqual({
      policy,
      reading,
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    expect(transactionClient.oracleReading.findFirst).toHaveBeenCalledWith({
      where: { key: 'rainfall:old' },
      orderBy: { submittedAt: 'desc' },
    });
  });

  it('cannot mix a concurrent policy update with a newer oracle key', async () => {
    const database = {
      policy: { id: 'policy-1', oracleKey: 'rainfall:v1' },
      readings: {
        'rainfall:v1': { id: 'reading-v1', key: 'rainfall:v1' },
        'rainfall:v2': { id: 'reading-v2', key: 'rainfall:v2' },
      } as Record<string, object>,
    };
    const prisma = {
      $transaction: jest.fn(async (callback) => {
        // Capture the database state as PostgreSQL does at REPEATABLE READ.
        const snapshot = structuredClone(database);
        const tx = {
          policy: {
            findUnique: jest.fn(async () => {
              database.policy.oracleKey = 'rainfall:v2'; // concurrent commit
              return snapshot.policy;
            }),
          },
          oracleReading: {
            findFirst: jest.fn(async ({ where }) => snapshot.readings[where.key] ?? null),
          },
        };
        return callback(tx);
      }),
    } as any;

    const result = await readClaimEvaluationSnapshot(prisma, 'policy-1');
    expect(result.policy?.oracleKey).toBe('rainfall:v1');
    expect(result.reading?.key).toBe('rainfall:v1');
    expect(database.policy.oracleKey).toBe('rainfall:v2');
  });
});
