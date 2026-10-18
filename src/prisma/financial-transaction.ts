import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Transaction options for every write that can lead to (or record) a payout:
 * claim creation, the ACTIVE → PROCESSING policy gate, and claim/policy
 * status transitions. See "Transaction strategy" in the README.
 *
 * Postgres defaults to READ COMMITTED, under which two concurrent
 * "check for an existing claim, then insert one" transactions can both pass
 * the check. SERIALIZABLE makes Postgres abort one of them with a
 * serialization failure (40001, surfaced by Prisma as P2034) instead, and
 * the retry then sees the winner's committed row.
 */
export const FINANCIAL_TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 5_000,
  timeout: 10_000,
} as const;

/** Total attempts (first try + retries) before a serialization failure is surfaced. */
export const FINANCIAL_TX_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 25;

type TransactionRunner = Pick<PrismaClient, '$transaction'>;

const logger = new Logger('FinancialTransaction');

/**
 * True for errors that mean "this transaction lost a concurrency conflict and
 * is safe to re-run from scratch": serialization failures and deadlocks.
 */
export function isSerializationFailure(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2034') return true;
    // Raw driver errors occasionally arrive under the generic P2010 code.
    return err.code === 'P2010' && /40001|40P01|could not serialize access/i.test(err.message);
  }
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return /40001|40P01|could not serialize access/i.test(err.message);
  }
  return false;
}

async function withSerializationRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!isSerializationFailure(err) || attempt >= FINANCIAL_TX_MAX_ATTEMPTS) throw err;
      // Jittered backoff so the colliding transactions don't retry in lockstep.
      const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) * (1 + Math.random());
      logger.warn(`${label}: serialization conflict on attempt ${attempt}/${FINANCIAL_TX_MAX_ATTEMPTS}, retrying in ${Math.round(delayMs)}ms`);
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Runs an interactive transaction at SERIALIZABLE isolation, re-running it
 * from the start on a serialization failure. `fn` may therefore execute more
 * than once and must not have side effects outside `tx` (no contract calls,
 * events or webhooks inside it).
 */
export function financialTransaction<T>(
  prisma: TransactionRunner,
  label: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withSerializationRetry(label, () => prisma.$transaction(fn, FINANCIAL_TX_OPTIONS));
}

/**
 * Array-form counterpart of `financialTransaction`. Takes a factory rather
 * than the operations themselves because a PrismaPromise can't be re-run, so
 * each retry needs freshly built operations.
 */
export function financialBatch<P extends Prisma.PrismaPromise<unknown>[]>(
  prisma: TransactionRunner,
  label: string,
  buildOps: () => [...P],
) {
  return withSerializationRetry(label, () => prisma.$transaction(buildOps(), FINANCIAL_TX_OPTIONS));
}
