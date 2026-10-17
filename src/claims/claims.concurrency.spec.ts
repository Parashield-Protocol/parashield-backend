/**
 * Concurrency tests for the claim flows against a real Postgres database.
 *
 * Isolation-level behaviour can't be meaningfully mocked, so these only run
 * when CONCURRENCY_TEST_DATABASE_URL points at a disposable database whose
 * schema is in sync with schema.prisma (e.g. `prisma db push`). Every table
 * used here is TRUNCATED between tests — never point it at real data.
 *
 *   CONCURRENCY_TEST_DATABASE_URL=postgresql://... npx jest claims.concurrency
 */
import { ConflictException } from '@nestjs/common';
import { ClaimStatus, PolicyStatus, Prisma, PrismaClient } from '@prisma/client';
import { ClaimsService } from './claims.service';
import { financialTransaction } from '../prisma/financial-transaction';

const DATABASE_URL = process.env.CONCURRENCY_TEST_DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const CONTRACT_ID = 'CC4CG7QPQ5B6CFUANVWFXPF76QCB5DUJCLU4QWPHZE2FP4XCLJAVC5K7';
const HOLDER = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
const ORACLE_KEY = 'rainfall:-0.1,34.7:2026-09';
const CONCURRENCY = 5;

const PRODUCT_SUMMARY = {
  id: '', name: 'Crop', category: 'crop', triggerType: 'Threshold',
  threshold: '50.0000000', comparison: 'LessThan',
  coverageMin: '10', coverageMax: '1000', premiumRate: 500, maxDuration: 365, status: 'ACTIVE',
};

describeWithDb('Claims concurrency (Postgres)', () => {
  let prisma: PrismaClient;
  let service: ClaimsService;
  let productId: string;
  let txCounter = 0;

  const stellar = { invokeContract: jest.fn() };
  const oracle = { getLatestReading: jest.fn() };
  const policyService = { getProductById: jest.fn() };
  const config = { get: jest.fn((key: string) => (key === 'CLAIMS_PROCESSOR_CONTRACT' ? CONTRACT_ID : undefined)) };
  const statusEvents = { emitPolicyStatusChange: jest.fn() };
  const webhooks = { notifyClaimStatusChange: jest.fn() };

  const uniqueTxHash = () => (++txCounter).toString(16).padStart(64, 'a');

  const seedPolicy = (endTime: Date) =>
    prisma.policy.create({
      data: {
        productId,
        policyholder: HOLDER,
        coverageXlm:  new Prisma.Decimal('100'),
        premiumPaid:  new Prisma.Decimal('5'),
        oracleKey:    ORACLE_KEY,
        startTime:    new Date(endTime.getTime() - 30 * 24 * 3600 * 1000),
        endTime,
        status:       PolicyStatus.ACTIVE,
      },
    });

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
    await prisma.$connect();
    // Raw migration (#230), not expressible in schema.prisma, so `db push` omits it.
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "claim_policy_non_terminal_unique" ON "Claim" ("policyId") WHERE "status" IN ('PENDING', 'PROCESSING')`,
    );
    service = new ClaimsService(
      stellar as never, oracle as never, policyService as never, config as never,
      prisma as never, statusEvents as never, webhooks as never,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await prisma.$executeRawUnsafe('TRUNCATE "AuditLog", "Claim", "Policy", "Product" CASCADE');
    const product = await prisma.product.create({
      data: {
        name: 'Crop', category: 'crop', triggerType: 'Threshold',
        threshold: new Prisma.Decimal('50'), comparison: 'LessThan',
        coverageMin: new Prisma.Decimal('10'), coverageMax: new Prisma.Decimal('1000'),
        premiumRate: 500, maxDuration: 365,
      },
    });
    productId = product.id;
  });

  const RealDate = Date;
  afterEach(() => {
    global.Date = RealDate;
  });

  describe('check-then-insert on claims not covered by the partial unique index', () => {
    // Both transactions read "no PAID claim" before either inserts — the exact
    // interleaving behind the double-payout report. A barrier forces it so the
    // outcome is deterministic rather than timing-dependent.
    async function raceInsertPaidClaim(
      runTx: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>,
    ) {
      const policy = await seedPolicy(new Date(Date.now() + 3600_000));
      let arrived = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });

      const attempt = () => runTx(async (tx) => {
        const existing = await tx.claim.findFirst({ where: { policyId: policy.id, status: ClaimStatus.PAID } });
        if (existing) return 'skipped';
        if (++arrived === 2) release();
        await barrier;
        await tx.claim.create({
          data: { policyId: policy.id, claimant: HOLDER, coverageAmount: new Prisma.Decimal('100'), status: ClaimStatus.PAID },
        });
        return 'inserted';
      });

      const results = await Promise.allSettled([attempt(), attempt()]);
      const paidRows = await prisma.claim.count({ where: { policyId: policy.id, status: ClaimStatus.PAID } });
      return { results, paidRows };
    }

    it('READ COMMITTED (the Postgres default) lets both transactions insert — the bug', async () => {
      const { paidRows } = await raceInsertPaidClaim((fn) =>
        prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }),
      );
      expect(paidRows).toBe(2);
    });

    it('financialTransaction (SERIALIZABLE + retry) lets exactly one insert and the retry sees it', async () => {
      const { results, paidRows } = await raceInsertPaidClaim((fn) => financialTransaction(prisma, 'race', fn));

      expect(paidRows).toBe(1);
      const values = results.map((r) => (r.status === 'fulfilled' ? r.value : r.reason));
      expect(values.sort()).toEqual(['inserted', 'skipped']);
    });
  });

  describe('submitClaim', () => {
    it(`creates exactly one claim when ${CONCURRENCY} submissions race on one policy`, async () => {
      const policy = await seedPolicy(new Date(Date.now() + 24 * 3600_000));
      stellar.invokeContract.mockImplementation(async () => uniqueTxHash());

      const results = await Promise.allSettled(
        Array.from({ length: CONCURRENCY }, () => service.submitClaim(HOLDER, policy.id)),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(CONCURRENCY - 1);
      for (const r of rejected) expect(r.reason).toBeInstanceOf(ConflictException);

      expect(await prisma.claim.count({ where: { policyId: policy.id } })).toBe(1);
      expect(stellar.invokeContract).toHaveBeenCalledTimes(1);
    });

    it('refuses to file when the policy changed after it was validated (optimistic lock)', async () => {
      const policy = await seedPolicy(new Date(Date.now() + 24 * 3600_000));
      // A status write lands between the initial read and the transaction:
      // the policy round-trips back to ACTIVE, but its version moved on.
      const realFindUnique = prisma.policy.findUnique.bind(prisma.policy);
      const spy = jest.spyOn(prisma.policy, 'findUnique').mockImplementationOnce((async (args: Prisma.PolicyFindUniqueArgs) => {
        const snapshot = await realFindUnique(args);
        await prisma.policy.update({ where: { id: policy.id }, data: { version: { increment: 1 } } });
        return snapshot;
      }) as never);

      await expect(service.submitClaim(HOLDER, policy.id)).rejects.toMatchObject({
        response: expect.objectContaining({ errorCode: 'CLAIM_CONCURRENT_MODIFICATION' }),
      });
      expect(await prisma.claim.count({ where: { policyId: policy.id } })).toBe(0);
      spy.mockRestore();
    });
  });

  describe('autoProcess', () => {
    // autoProcess currently returns 'Expired' when now > endTime and
    // 'PendingFinalPeriod' when now < endTime, so evaluation only happens at
    // exactly endTime. Pin `new Date()` there so the claim path is actually
    // exercised; Date.now() and timers stay real because Prisma relies on them.
    async function seedDuePolicy() {
      const endTime = new Date(Date.now() - 60_000);
      const policy = await seedPolicy(endTime);
      global.Date = class extends RealDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) super(endTime.getTime());
          else super(...(args as [string]));
        }
      } as DateConstructor;
      oracle.getLatestReading.mockResolvedValue({ key: ORACLE_KEY, value: BigInt(200_000_000), confidence: 90 });
      return policy;
    }
    const productsMap = () => new Map([[productId, { ...PRODUCT_SUMMARY, id: productId }]]);

    it(`pays out exactly once when ${CONCURRENCY} workers process one policy concurrently`, async () => {
      const policy = await seedDuePolicy();
      stellar.invokeContract.mockImplementation(async () => uniqueTxHash());

      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => service.autoProcess(policy.id, productsMap())),
      );

      expect(results.filter((r) => r === 'Paid')).toHaveLength(1);
      expect(results.filter((r) => r === 'AlreadyProcessed')).toHaveLength(CONCURRENCY - 1);
      expect(stellar.invokeContract).toHaveBeenCalledTimes(1);

      const claims = await prisma.claim.findMany({ where: { policyId: policy.id } });
      expect(claims.map((c) => c.status)).toEqual([ClaimStatus.PAID]);
      const after = await prisma.policy.findUniqueOrThrow({ where: { id: policy.id } });
      expect(after.status).toBe(PolicyStatus.CLAIMED);
      expect(after.version).toBe(2); // ACTIVE → PROCESSING → CLAIMED
    });

    it('does not mark a re-gated policy CLAIMED from a stale attempt (ABA)', async () => {
      const policy = await seedDuePolicy();
      // While this attempt is waiting on the contract, the stuck-PROCESSING
      // sweep reverts the policy and another attempt gates it again: status is
      // PROCESSING once more, but it belongs to a different attempt.
      stellar.invokeContract.mockImplementation(async () => {
        await prisma.policy.update({ where: { id: policy.id }, data: { status: PolicyStatus.ACTIVE, version: { increment: 1 } } });
        await prisma.policy.update({ where: { id: policy.id }, data: { status: PolicyStatus.PROCESSING, version: { increment: 1 } } });
        return uniqueTxHash();
      });

      await service.autoProcess(policy.id, productsMap());

      const after = await prisma.policy.findUniqueOrThrow({ where: { id: policy.id } });
      // A status-only guard would have matched PROCESSING and written CLAIMED.
      expect(after.status).toBe(PolicyStatus.PROCESSING);
      expect(after.version).toBe(3);
    });
  });
});
