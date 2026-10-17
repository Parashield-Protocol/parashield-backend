import { Prisma } from '@prisma/client';
import {
  FINANCIAL_TX_MAX_ATTEMPTS,
  FINANCIAL_TX_OPTIONS,
  financialBatch,
  financialTransaction,
  isSerializationFailure,
} from './financial-transaction';

const writeConflict = () =>
  new Prisma.PrismaClientKnownRequestError(
    'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
    { code: 'P2034', clientVersion: 'test' },
  );

describe('financial-transaction', () => {
  beforeEach(() => {
    // Keep the jittered backoff from slowing the suite down.
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('isSerializationFailure', () => {
    it('recognises P2034 write conflicts / deadlocks', () => {
      expect(isSerializationFailure(writeConflict())).toBe(true);
    });

    it('recognises raw SQLSTATE 40001 surfaced as an unknown request error', () => {
      const err = new Prisma.PrismaClientUnknownRequestError(
        'ERROR: could not serialize access due to read/write dependencies among transactions (40001)',
        { clientVersion: 'test' },
      );
      expect(isSerializationFailure(err)).toBe(true);
    });

    it('does not treat unique violations or plain errors as retryable', () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
      expect(isSerializationFailure(p2002)).toBe(false);
      expect(isSerializationFailure(new Error('boom'))).toBe(false);
    });
  });

  describe('financialTransaction', () => {
    it('runs the callback at SERIALIZABLE isolation', async () => {
      const prisma = { $transaction: jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn('tx')) };

      const result = await financialTransaction(prisma as never, 'test', async (tx) => `ran with ${tx}`);

      expect(result).toBe('ran with tx');
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), FINANCIAL_TX_OPTIONS);
      expect(FINANCIAL_TX_OPTIONS.isolationLevel).toBe('Serializable');
    });

    it('re-runs the whole transaction after a serialization failure', async () => {
      const prisma = {
        $transaction: jest.fn()
          .mockRejectedValueOnce(writeConflict())
          .mockImplementation((fn: (tx: unknown) => unknown) => fn('tx')),
      };
      const body = jest.fn().mockResolvedValue('ok');

      await expect(financialTransaction(prisma as never, 'test', body)).resolves.toBe('ok');
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it(`gives up after ${FINANCIAL_TX_MAX_ATTEMPTS} attempts and rethrows the conflict`, async () => {
      const prisma = { $transaction: jest.fn().mockRejectedValue(writeConflict()) };

      await expect(financialTransaction(prisma as never, 'test', jest.fn())).rejects.toMatchObject({ code: 'P2034' });
      expect(prisma.$transaction).toHaveBeenCalledTimes(FINANCIAL_TX_MAX_ATTEMPTS);
    });

    it('does not retry business errors thrown inside the callback', async () => {
      const prisma = { $transaction: jest.fn().mockRejectedValue(new Error('Claim already exists')) };

      await expect(financialTransaction(prisma as never, 'test', jest.fn())).rejects.toThrow('Claim already exists');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('financialBatch', () => {
    it('rebuilds the operations for every attempt', async () => {
      const prisma = {
        $transaction: jest.fn()
          .mockRejectedValueOnce(writeConflict())
          .mockImplementation((ops: unknown[]) => Promise.all(ops)),
      };
      const buildOps = jest.fn(() => [Promise.resolve('a'), Promise.resolve('b')] as unknown as Prisma.PrismaPromise<string>[]);

      await expect(financialBatch(prisma as never, 'test', buildOps)).resolves.toEqual(['a', 'b']);
      expect(buildOps).toHaveBeenCalledTimes(2);
      expect(prisma.$transaction).toHaveBeenLastCalledWith(expect.any(Array), FINANCIAL_TX_OPTIONS);
    });
  });
});
