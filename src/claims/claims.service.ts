import { Injectable, Logger, BadRequestException, ConflictException, NotFoundException, BadGatewayException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { StellarService } from '../stellar/stellar.service';
import { OracleService } from '../oracle/oracle.service';
import { PolicyService, ProductSummary, PolicySummary } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { transition } from '../policy/policy-status.machine';
import { Prisma, ClaimStatus, PolicyStatus } from '@prisma/client';
import { WebhooksService } from '../common/events/webhooks.service';
import { StatusEventsService } from '../common/events/status-events.service';

export type ClaimResult = 'Paid' | 'Rejected' | 'Expired' | 'AlreadyClaimed' | 'AlreadyProcessed' | 'PolicyNotActive' | 'PendingFinalPeriod';

export interface ClaimSummary {
  id:             string;
  policyId:       string;
  claimant:       string;
  coverageAmount: string;
  payoutAmount:   string | null;
  triggerMet:     boolean;
  status:         string;
  submittedAt:    number;
  processedAt:    number | null;
  // #344 — both columns exist on the Claim model but were dropped when
  // mapping to this summary shape, so the API response silently lost them.
  txHash:         string | null;
  createdAt:      number;
}

/** Outcome counts from a single stuck-PROCESSING recovery sweep (#486). */
export interface StuckPolicyRecoverySummary {
  scanned:           number;
  revertedToActive:  number;
  markedClaimed:     number;
  // PROCESSING claim with a txHash: on-chain outcome unknown, not retried.
  needsManualReview: number;
  skipped:           number;
}

// #486 — how long a policy may sit in PROCESSING before the worker treats
// the claim flow as dead. autoProcess holds the gate for seconds (oracle read
// + one Soroban call), so this is far outside any legitimate in-flight window.
const DEFAULT_STUCK_PROCESSING_MINUTES = 30;

// #589 — per-wallet claim totals are cached briefly so paginated history
// requests don't run a COUNT on every page. Entries are dropped whenever a
// claim is created for the wallet, so the total never lags a new claim.
const CLAIM_COUNT_CACHE_TTL_MS = 30_000;
const CLAIM_COUNT_CACHE_MAX_ENTRIES = 1000;

/**
 * ClaimsService — submits and queries claims on the Claims Processor contract.
 *
 * The primary flow is `autoProcess` — triggered by the ClaimsWorker on a schedule.
 * No manual claim filing required for parametric insurance.
 */
@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);
  private readonly claimCountCache = new Map<string, { total: number; expiresAt: number }>();

  constructor(
    private readonly stellar: StellarService,
    private readonly oracleService: OracleService,
    private readonly policyService: PolicyService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly statusEvents: StatusEventsService,
    private readonly webhooks: WebhooksService,
  ) {}

  // #583 — reserves the next call slot synchronously, then waits for it, so
  // concurrent callers are spaced CONTRACT_CALL_MIN_INTERVAL_MS apart.
  private async waitForContractCallSlot(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextContractCallAt);
    this.nextContractCallAt = slot + CONTRACT_CALL_MIN_INTERVAL_MS;
    if (slot > now) {
      await new Promise<void>((resolve) => setTimeout(resolve, slot - now));
    }
  }

  // #350 — builds an auditLog.create() operation to append to a
  // $transaction([...]) array alongside the status-changing write itself,
  // so the two commit together and the audit trail can't fall out of sync
  // with the actual status history.
  private auditOp(entityType: 'Policy' | 'Claim', entityId: string, fromStatus: string, toStatus: string, reason?: string) {
    return this.prisma.auditLog.create({
      data: { entityType, entityId, fromStatus, toStatus, reason },
    });
  }

  /** Trigger automatic claim evaluation for a policy. */
  async autoProcess(policyId: string, productsMap?: Map<string, ProductSummary>): Promise<ClaimResult> {
    this.logger.log(`auto_process policy: ${policyId}`);

    // Fetch policy from DB to verify it exists and is active
    const policy = await this.prisma.policy.findUnique({ where: { id: policyId } });
    if (!policy) {
      this.logger.warn(`Policy ${policyId} not found in DB`);
      return 'PolicyNotActive';
    }

    if (policy.status !== PolicyStatus.ACTIVE) {
      this.logger.warn(`Policy ${policyId} is not ACTIVE (status: ${policy.status})`);
      return 'PolicyNotActive';
    }

    // Expired check — policy.endTime is the authoritative reference, not the
    // lazily-updated status column (the EXPIRED cron runs at best once an hour).
    if (new Date() > policy.endTime) {
      this.logger.warn(`Policy ${policyId} coverage period ended at ${policy.endTime.toISOString()}`);
      return 'Expired';
    }

    // #258 — the worker looks ahead up to 1 hour before endTime so the Soroban
    // tx has time to confirm, but oracle keys that aggregate a whole period
    // (e.g. a rainfall month) may not be fully ingested until that period has
    // actually elapsed. Evaluating the trigger against a partial reading and
    // terminally REJECTING would be silent and irreversible. Skip without
    // touching any state until endTime has actually passed — the next hourly
    // tick will pick this policy back up (it's still ACTIVE with the same
    // endTime) once the full period's data is available.
    if (new Date() < policy.endTime) {
      this.logger.log(
        `Policy ${policyId} endTime (${policy.endTime.toISOString()}) not yet reached — deferring trigger evaluation`,
      );
      return 'PendingFinalPeriod';
    }

    // #163 — Duplicate guard: prevent double payouts or duplicate in-flight processing
    const existingClaim = await this.prisma.claim.findFirst({
      where: {
        policyId,
        status: { in: [ClaimStatus.PROCESSING, ClaimStatus.PAID, ClaimStatus.REJECTED] },
      },
    });

    if (existingClaim) {
      this.logger.warn(
        `Duplicate autoProcess call for policy ${policyId} — existing claim id=${existingClaim.id} status=${existingClaim.status}`,
      );
      return 'AlreadyProcessed';
    }

    // #164 — Atomic policy gate: flip policy to PROCESSING atomically so a concurrent
    // autoProcess call that read the same ACTIVE snapshot loses the race here, before
    // any oracle read or contract call is made. Using updateMany with a conditional
    // WHERE ensures exactly one caller proceeds; the other sees count=0 and bails.
    const gateResult = await this.prisma.policy.updateMany({
      where: { id: policyId, status: PolicyStatus.ACTIVE },
      data:  { status: PolicyStatus.PROCESSING },
    });

    if (gateResult.count === 0) {
      this.logger.warn(
        `Policy ${policyId} status gate missed — already claimed by a concurrent call`,
      );
      return 'AlreadyProcessed';
    }
    // #350 — best-effort audit write after the guarded update succeeds; not
    // folded into the update itself so the gate can't be blocked by an
    // audit-log write failure.
    await this.auditOp('Policy', policyId, PolicyStatus.ACTIVE, PolicyStatus.PROCESSING, 'autoProcess claim evaluation started')
      .catch((err) => this.logger.error(`Failed to write audit log for policy ${policyId} PROCESSING gate`, err));
    this.statusEvents.emitPolicyStatusChange(policyId, PolicyStatus.PROCESSING);

    this.logger.log(`Processing claim for policy: id=${policy.id} holder=${policy.policyholder} coverage=${policy.coverageXlm}`);

    // Persist initial claim record with PROCESSING status
    const claim = await this.prisma.claim.create({
      data: {
        policyId,
        claimant:       policy.policyholder,
        coverageAmount: policy.coverageXlm,
        triggerMet:     false,
        status:         ClaimStatus.PROCESSING,
      },
    });

    this.claimCountCache.delete(policy.policyholder);
    this.logger.log(`Claim record created: id=${claim.id} policyId=${policyId}`);

    // Fetch latest oracle reading for this policy's oracle key
    const reading = await this.oracleService.getLatestReading(policy.oracleKey);
    if (!reading) {
      this.logger.warn(`No oracle reading for key=${policy.oracleKey} — rejecting claim ${claim.id}`);
      await this.prisma.$transaction([
        this.prisma.claim.update({
          where: { id: claim.id },
          data:  { status: ClaimStatus.REJECTED, processedAt: new Date() },
        }),
        this.auditOp('Claim', claim.id, ClaimStatus.PROCESSING, ClaimStatus.REJECTED, 'No oracle reading available'),
      ]);
      return 'Rejected';
    }

    // Evaluate trigger condition against product definition (#120: direct lookup, #266: cached map lookup).
    // #492 — when the worker supplies productsMap (every ACTIVE product, loaded
    // once per tick) it is authoritative: getProductById applies the same
    // ACTIVE filter, so a miss here would just be one wasted query per policy
    // that can only return null. Only callers without a map hit the DB.
    const product = productsMap
      ? (productsMap.get(policy.productId) ?? null)
      : await this.policyService.getProductById(policy.productId);
    if (!product) {
      // #259 — the product may have been deactivated after this policy was
      // sold. Silently substituting a hardcoded threshold/comparison here
      // would evaluate the claim against rules that don't match what the
      // policyholder actually bought. Fail loud and revert the atomic gate
      // so this is caught for manual review instead of silently mis-scored.
      this.logger.error(
        `Product ${policy.productId} not found for policy ${policyId} — cannot evaluate trigger, marking claim FAILED for manual review`,
      );
      await this.prisma.$transaction([
        this.prisma.claim.update({
          where: { id: claim.id },
          data:  { status: ClaimStatus.FAILED, processedAt: new Date() },
        }),
        this.prisma.policy.updateMany({
          where: { id: policyId, status: PolicyStatus.PROCESSING },
          data:  { status: PolicyStatus.ACTIVE },
        }),
        this.auditOp('Claim', claim.id, ClaimStatus.PROCESSING, ClaimStatus.FAILED, 'Product not found'),
        this.auditOp('Policy', policyId, PolicyStatus.PROCESSING, PolicyStatus.ACTIVE, 'Reverted: product not found'),
      ]);
      this.statusEvents.emitPolicyStatusChange(policyId, PolicyStatus.ACTIVE);
      this.webhooks.notifyClaimStatusChange({
        claimId: claim.id,
        fromStatus: ClaimStatus.PROCESSING,
        toStatus: ClaimStatus.FAILED,
        timestamp: Date.now(),
      });
      return 'Rejected';
    }
    // #245 — Guard against non-numeric threshold values. Product.threshold is a
    // free-text string at the service boundary (Decimal serialised via .toString()).
    // parseFloat('') or parseFloat('N/A') yields NaN, and BigInt(NaN) throws a
    // RangeError — crashing mid-flow after the claim row is already PROCESSING.
    // Treat an unparseable threshold the same as a missing product: fail loud for
    // manual review and revert the atomic gate so the policy can be retried.
    const rawThreshold = parseFloat(product.threshold);
    if (!isFinite(rawThreshold)) {
      this.logger.error(
        `Product ${policy.productId} has non-numeric threshold "${product.threshold}" — cannot evaluate trigger for policy ${policyId}, marking claim FAILED for manual review`,
      );
      await this.prisma.$transaction([
        this.prisma.claim.update({
          where: { id: claim.id },
          data:  { status: ClaimStatus.FAILED, processedAt: new Date() },
        }),
        this.prisma.policy.updateMany({
          where: { id: policyId, status: PolicyStatus.PROCESSING },
          data:  { status: PolicyStatus.ACTIVE },
        }),
this.auditOp('Claim', claim.id, ClaimStatus.PROCESSING, ClaimStatus.FAILED, 'Non-numeric product threshold'),
        this.auditOp('Policy', policyId, PolicyStatus.PROCESSING, PolicyStatus.ACTIVE, 'Reverted: non-numeric product threshold'),
      ]);
      this.statusEvents.emitPolicyStatusChange(policyId, PolicyStatus.ACTIVE);
      this.webhooks.notifyClaimStatusChange({
        claimId: claim.id,
        fromStatus: ClaimStatus.PROCESSING,
        toStatus: ClaimStatus.FAILED,
        timestamp: Date.now(),
      });
      return 'Rejected';
    }
    const threshold  = BigInt(Math.round(rawThreshold * 1e7));
    const comparison = product.comparison;

    const readingValue = BigInt(reading.value);
    const triggerMet = comparison === 'LessThan'
      ? readingValue < threshold
      : readingValue > threshold;

    this.logger.log(
      `Trigger eval: key=${reading.key} value=${reading.value} threshold=${threshold} triggerMet=${triggerMet}`,
    );

    if (!triggerMet) {
      await this.prisma.$transaction([
        this.prisma.claim.update({
          where: { id: claim.id },
          data:  { status: ClaimStatus.REJECTED, triggerMet: false, processedAt: new Date() },
        }),
        this.auditOp('Claim', claim.id, ClaimStatus.PROCESSING, ClaimStatus.REJECTED, 'Trigger condition not met'),
      ]);
      return 'Rejected';
    }

    // Trigger met — initiate Soroban payout via Claims Processor contract
    const contractId = this.config.get<string>('CLAIMS_PROCESSOR_CONTRACT') ?? '';
    if (!contractId || !/^C[A-Z2-7]{55}$/.test(contractId)) {
      throw new BadGatewayException(
        'CLAIMS_PROCESSOR_CONTRACT not configured or invalid format. Expected a Stellar contract ID (C...).',
      );
    }

    let txHash: string;
    try {
      await this.waitForContractCallSlot();
      txHash = await this.stellar.invokeContract(
        contractId,
        'process_claim',
        [nativeToScVal(policyId, { type: 'string' })],
      );
      this.logger.log(`Soroban payout initiated: txHash=${txHash} claimId=${claim.id}`);
    } catch (err) {
      // #165 — payout failure: mark claim FAILED and revert the atomic policy gate so
      // the policy can be retried on the next worker tick rather than being stuck.
      this.logger.error(`Soroban payout failed for claim ${claim.id}`, err);
      await this.prisma.$transaction([
        this.prisma.claim.update({
          where: { id: claim.id },
          data:  { status: ClaimStatus.FAILED, processedAt: new Date() },
        }),
        this.prisma.policy.updateMany({
          where: { id: policyId, status: PolicyStatus.PROCESSING },
          data:  { status: PolicyStatus.ACTIVE },
        }),
        this.auditOp('Claim', claim.id, ClaimStatus.PROCESSING, ClaimStatus.FAILED, 'On-chain payout failed'),
        this.auditOp('Policy', policyId, PolicyStatus.PROCESSING, PolicyStatus.ACTIVE, 'Reverted: on-chain payout failed'),
      ]);
this.statusEvents.emitPolicyStatusChange(policyId, PolicyStatus.ACTIVE);
      this.webhooks.notifyClaimStatusChange({
        claimId: claim.id,
        fromStatus: ClaimStatus.PROCESSING,
        toStatus: ClaimStatus.FAILED,
        timestamp: Date.now(),
      });
      return 'Rejected';
    }

    // #166 — Wrap both DB writes in a single transaction so a crash between them can't
    // leave claim=PROCESSING / policy=PROCESSING while txHash is already on-chain.
    // On retry the duplicate-guard or atomic gate above catches the already-PROCESSING
    // claim/policy and returns AlreadyProcessed instead of re-invoking the contract.
    //
    // #260 — the policy write is guarded with an expected-status WHERE (rather than
    // `where: { id }` alone) so a second status-writing path racing on this row can't
    // silently clobber it; the affected-row count is checked below.
    const [, policyUpdateResult] = await this.prisma.$transaction([
      this.prisma.claim.update({
        where: { id: claim.id },
        data:  { status: ClaimStatus.PAID, triggerMet: true, processedAt: new Date(), txHash, payoutAmount: policy.coverageXlm },
      }),
      this.prisma.policy.updateMany({
        where: { id: policyId, status: PolicyStatus.PROCESSING },
        data:  { status: transition('PROCESSING', 'CLAIMED') as PolicyStatus },
      }),
      this.auditOp('Claim', claim.id, ClaimStatus.PROCESSING, ClaimStatus.PAID, `Payout confirmed, txHash=${txHash}`),
    ]);

    if (policyUpdateResult.count === 0) {
      this.logger.error(
        `Policy ${policyId} status guard missed on CLAIMED transition — status changed underneath a paid claim (claim ${claim.id}, txHash ${txHash})`,
      );
    } else {
      // Logged outside the transaction above since whether the policy guard
      // succeeded is only known from its result, and the array $transaction
      // form runs every statement unconditionally -- an audit row here can't
      // be made conditional on `count` without an interactive transaction,
      // which would mean re-running the payout-confirming claim write inside
      // a second transaction. A best-effort log call after the fact is an
      // acceptable tradeoff for this rare guard-miss path.
      await this.prisma.auditLog.create({
        data: { entityType: 'Policy', entityId: policyId, fromStatus: PolicyStatus.PROCESSING, toStatus: PolicyStatus.CLAIMED, reason: `Payout confirmed, txHash=${txHash}` },
      }).catch((err) => this.logger.error(`Failed to write audit log for policy ${policyId} CLAIMED transition`, err));
      this.statusEvents.emitPolicyStatusChange(policyId, PolicyStatus.CLAIMED);
      this.webhooks.notifyClaimStatusChange({
        claimId: claim.id,
        fromStatus: ClaimStatus.PROCESSING,
        toStatus: ClaimStatus.PAID,
        timestamp: Date.now(),
      });
    }

    return 'Paid';
  }

  /**
   * #486 — recover policies stranded in PROCESSING.
   *
   * autoProcess flips a policy ACTIVE → PROCESSING before evaluating it, and
   * relies on later writes to move it on. If the process crashes, the DB
   * write fails, or the payout-failure rollback itself fails, nothing ever
   * touches the row again: the worker only scans ACTIVE policies. The
   * trigger-not-met / no-reading paths also leave the policy in PROCESSING,
   * which the worker's guarded ACTIVE → EXPIRED update then misses.
   *
   * Any policy whose PROCESSING status is older than
   * CLAIMS_STUCK_PROCESSING_MINUTES (default 30) is resolved from its claims:
   *  - a PAID claim exists           → CLAIMED (payout already recorded)
   *  - a PROCESSING claim has a txHash → left as-is and logged (something
   *    was submitted on-chain but its outcome is unknown; retrying could
   *    double-pay, so it needs manual review)
   *  - otherwise                     → ACTIVE, with any PROCESSING claims
   *    marked FAILED, so the next worker scan re-evaluates it (retry) or
   *    expires it exactly like any other ACTIVE policy.
   *
   * Every write is guarded on status = PROCESSING and the same updatedAt
   * cutoff, so a policy that makes progress concurrently is left alone.
   */
  async recoverStuckProcessingPolicies(now: Date = new Date()): Promise<StuckPolicyRecoverySummary> {
    const configured = parseInt(this.config.get<string>('CLAIMS_STUCK_PROCESSING_MINUTES') ?? '', 10);
    const stuckMinutes = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STUCK_PROCESSING_MINUTES;
    const cutoff = new Date(now.getTime() - stuckMinutes * 60 * 1000);

    const stuck = await this.prisma.policy.findMany({
      where:  { status: PolicyStatus.PROCESSING, updatedAt: { lt: cutoff } },
      select: { id: true, claims: { select: { id: true, status: true, txHash: true } } },
    });

    const summary: StuckPolicyRecoverySummary = {
      scanned: stuck.length, revertedToActive: 0, markedClaimed: 0, needsManualReview: 0, skipped: 0,
    };
    if (stuck.length === 0) return summary;

    this.logger.warn(`Found ${stuck.length} policies stuck in PROCESSING for more than ${stuckMinutes} minutes — recovering`);

    for (const policy of stuck) {
      const guard = { id: policy.id, status: PolicyStatus.PROCESSING, updatedAt: { lt: cutoff } };
      const paidClaim = policy.claims.find((c) => c.status === ClaimStatus.PAID);
      const inFlightClaims = policy.claims.filter((c) => c.status === ClaimStatus.PROCESSING);
      const unconfirmedOnChain = inFlightClaims.find((c) => c.txHash);

      try {
        if (paidClaim) {
          const { count } = await this.prisma.policy.updateMany({
            where: guard,
            data:  { status: transition(PolicyStatus.PROCESSING, PolicyStatus.CLAIMED) as PolicyStatus },
          });
          if (count === 0) { summary.skipped++; continue; }
          await this.auditOp('Policy', policy.id, PolicyStatus.PROCESSING, PolicyStatus.CLAIMED, `Recovered stuck PROCESSING: claim ${paidClaim.id} already PAID`)
            .catch((err) => this.logger.error(`Failed to write audit log for policy ${policy.id} recovery`, err));
          this.statusEvents.emitPolicyStatusChange(policy.id, PolicyStatus.CLAIMED);
          summary.markedClaimed++;
          this.logger.warn(`Recovered stuck policy ${policy.id} → CLAIMED (claim ${paidClaim.id} already PAID)`);
          continue;
        }

        if (unconfirmedOnChain) {
          // Left in PROCESSING on purpose (and re-reported every sweep): the
          // PolicyStatus enum has no ERROR state to park it in, and reverting
          // to ACTIVE would let the next scan re-invoke the contract.
          summary.needsManualReview++;
          this.logger.error(
            `Stuck policy ${policy.id} has claim ${unconfirmedOnChain.id} with unconfirmed txHash=${unconfirmedOnChain.txHash} — not retrying, manual review required`,
          );
          continue;
        }

        const reverted = await this.prisma.$transaction(async (tx) => {
          const { count } = await tx.policy.updateMany({
            where: guard,
            data:  { status: transition(PolicyStatus.PROCESSING, PolicyStatus.ACTIVE) as PolicyStatus },
          });
          if (count === 0) return false;
          if (inFlightClaims.length > 0) {
            await tx.claim.updateMany({
              where: { id: { in: inFlightClaims.map((c) => c.id) }, status: ClaimStatus.PROCESSING },
              data:  { status: ClaimStatus.FAILED, processedAt: now },
            });
          }
          await tx.auditLog.createMany({
            data: [
              ...inFlightClaims.map((c) => ({
                entityType: 'Claim', entityId: c.id,
                fromStatus: ClaimStatus.PROCESSING, toStatus: ClaimStatus.FAILED,
                reason: 'Recovered stuck PROCESSING: claim flow did not complete',
              })),
              {
                entityType: 'Policy', entityId: policy.id,
                fromStatus: PolicyStatus.PROCESSING, toStatus: PolicyStatus.ACTIVE,
                reason: `Recovered stuck PROCESSING after ${stuckMinutes} minutes`,
              },
            ],
          });
          return true;
        });
        if (!reverted) { summary.skipped++; continue; }

        this.statusEvents.emitPolicyStatusChange(policy.id, PolicyStatus.ACTIVE);
        for (const c of inFlightClaims) {
          this.webhooks.notifyClaimStatusChange({
            claimId: c.id,
            fromStatus: ClaimStatus.PROCESSING,
            toStatus: ClaimStatus.FAILED,
            timestamp: Date.now(),
          });
        }
        summary.revertedToActive++;
        this.logger.warn(`Recovered stuck policy ${policy.id} → ACTIVE (${inFlightClaims.length} in-flight claims marked FAILED)`);
      } catch (err) {
        // One bad row must not block recovery of the rest; it stays
        // PROCESSING and is retried on the next sweep.
        summary.skipped++;
        this.logger.error(`Failed to recover stuck policy ${policy.id}`, err);
      }
    }

    return summary;
  }

  /** Manually submit a claim for a policy (initiated by policyholder). */
  async submitClaim(claimant: string, policyId: string): Promise<string> {
    this.logger.log(`submit_claim: policy=${policyId} claimant=${claimant}`);

    // Policy ids are UUIDs — reject any other format before hitting the DB.
    if (!UUID_PATTERN.test(policyId)) {
      throw new BadRequestException('policyId must be a valid UUID');
    }

    // #371 — Resolve policy and validate ownership FIRST, before any status
    // or duplicate-claim probes. Running the duplicate guard with only a
    // policyId before ownership checks would let an authenticated stranger
    // enumerate whether any active/processing claim exists on someone else's
    // policy by watching for ConflictException vs ForbiddenException.
    const policy = await this.prisma.policy.findUnique({ where: { id: policyId } });
    if (!policy) {
      throw new NotFoundException(`Policy ${policyId} not found`);
    }
    // #177 — the JWT-authenticated wallet must own the policy being claimed
    // against; otherwise any authenticated wallet could file a claim on
    // someone else's policy.
    if (policy.policyholder !== claimant) {
      throw new ForbiddenException(`Wallet ${claimant} does not own policy ${policyId}`);
    }
    if (policy.status !== PolicyStatus.ACTIVE) {
      throw new ConflictException(`Policy ${policyId} is not active`);
    }

    // Expired check — policy.endTime is the authoritative reference, not the
    // lazily-updated status column (the EXPIRED cron runs at best once an hour).
    if (new Date() > policy.endTime) {
      throw new ConflictException(`Policy ${policyId} coverage period ended at ${policy.endTime.toISOString()}`);
    }

    // Duplicate claim guard: prevent double payouts or duplicate in-flight submissions
    const existingClaim = await this.prisma.claim.findFirst({
      where: {
        policyId,
        status: { in: [ClaimStatus.PAID, ClaimStatus.PROCESSING, ClaimStatus.PENDING] },
      },
    });

    if (existingClaim) {
      this.logger.warn(
        `Duplicate claim attempt for policy ${policyId} — existing claim id=${existingClaim.id} status=${existingClaim.status}`,
      );
      throw new ConflictException('Claim already exists for this policy');
    }

    const contractId = this.config.get<string>('CLAIMS_PROCESSOR_CONTRACT') ?? '';
    if (!contractId || !/^C[A-Z2-7]{55}$/.test(contractId)) {
      throw new BadGatewayException(
        'CLAIMS_PROCESSOR_CONTRACT not configured or invalid format. Expected a Stellar contract ID (C...).',
      );
    }

    let claim: Awaited<ReturnType<typeof this.prisma.claim.create>>;
    try {
      claim = await this.prisma.claim.create({
        data: {
          policyId,
          claimant,
          coverageAmount: policy.coverageXlm,
          triggerMet:     false,
          status:         ClaimStatus.PENDING,
        },
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Claim already exists for this policy');
      }
      throw error;
    }

    this.claimCountCache.delete(claimant);
    this.logger.log(`Claim record created: id=${claim.id} policyId=${policyId}`);

    try {
      await this.waitForContractCallSlot();
      const txHash = await this.stellar.invokeContract(
        contractId,
        'submit_claim',
        [
          nativeToScVal(claim.id, { type: 'string' }),
          nativeToScVal(policyId, { type: 'string' }),
          nativeToScVal(claimant, { type: 'string' }),
        ],
      );
      this.logger.log(`Manual claim submitted on-chain: id=${claim.id} txHash=${txHash}`);
      await this.prisma.$transaction([
        this.prisma.claim.update({
          where: { id: claim.id },
          data:  { status: ClaimStatus.PROCESSING, txHash },
        }),
        this.auditOp('Claim', claim.id, ClaimStatus.PENDING, ClaimStatus.PROCESSING, `Submitted on-chain, txHash=${txHash}`),
      ]);
    } catch (err) {
      this.logger.error(`On-chain submission failed for claim ${claim.id}: ${(err as Error).message}`, err);
      // Use FAILED (not REJECTED) for on-chain errors — REJECTED means trigger condition not met (#119)
      await this.prisma.$transaction([
        this.prisma.claim.update({
          where: { id: claim.id },
          data:  { status: ClaimStatus.FAILED, processedAt: new Date() },
        }),
        this.auditOp('Claim', claim.id, ClaimStatus.PENDING, ClaimStatus.FAILED, 'On-chain submission failed'),
      ]);
    }

    return claim.id;
  }

  async getClaimsByWallet(walletAddress: string, page = 1, limit = 20): Promise<{ data: ClaimSummary[]; total: number; page: number; limit: number }> {
    // Clamp to valid bounds; page is 1-based (#114)
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(Math.max(1, limit), 100);
    this.logger.log(`get_claims_by_wallet: ${walletAddress} page=${safePage} limit=${safeLimit}`);
    const findClaims = this.prisma.claim.findMany({
      where: { claimant: walletAddress },
      orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    });

    // #589 — reuse a recent total instead of running COUNT on every request
    const cached = this.claimCountCache.get(walletAddress);
    let claims: Awaited<typeof findClaims>;
    let total: number;
    if (cached && cached.expiresAt > Date.now()) {
      claims = await findClaims;
      total = cached.total;
    } else {
      [claims, total] = await this.prisma.$transaction([
        findClaims,
        this.prisma.claim.count({ where: { claimant: walletAddress } }),
      ]);
      if (this.claimCountCache.size >= CLAIM_COUNT_CACHE_MAX_ENTRIES) {
        this.claimCountCache.clear();
      }
      this.claimCountCache.set(walletAddress, { total, expiresAt: Date.now() + CLAIM_COUNT_CACHE_TTL_MS });
    }

    const summaries = claims.map((claim) => ({
      id:             claim.id,
      policyId:       claim.policyId,
      claimant:       claim.claimant,
      coverageAmount: claim.coverageAmount.toString(),
      payoutAmount:   claim.payoutAmount?.toString() ?? null,
      triggerMet:     claim.triggerMet,
      status:         claim.status,
      submittedAt:    Math.floor(claim.submittedAt.getTime() / 1000),
      processedAt:    claim.processedAt
        ? Math.floor(claim.processedAt.getTime() / 1000)
        : null,
      txHash:         claim.txHash,
      createdAt:      Math.floor(claim.createdAt.getTime() / 1000),
    }));

    return {
      data: summaries,
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  async getClaim(claimId: string): Promise<(ClaimSummary & { policy?: PolicySummary }) | null> {
    this.logger.log(`get_claim: ${claimId}`);
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
      include: { policy: true },
    });
    if (!claim) return null;

    const summary: ClaimSummary & { policy?: PolicySummary } = {
      id:             claim.id,
      policyId:       claim.policyId,
      claimant:       claim.claimant,
      coverageAmount: claim.coverageAmount.toString(),
      payoutAmount:   claim.payoutAmount?.toString() ?? null,
      triggerMet:     claim.triggerMet,
      status:         claim.status,
      submittedAt:    Math.floor(claim.submittedAt.getTime() / 1000),
      processedAt:    claim.processedAt
        ? Math.floor(claim.processedAt.getTime() / 1000)
        : null,
      txHash:         claim.txHash,
      createdAt:      Math.floor(claim.createdAt.getTime() / 1000),
    };

    if (claim.policy) {
      summary.policy = {
        id:             claim.policy.id,
        productId:      claim.policy.productId,
        policyholder:   claim.policy.policyholder,
        coverage:       claim.policy.coverageXlm.toString(),
        premiumPaid:    claim.policy.premiumPaid.toString(),
        oracleKey:      claim.policy.oracleKey,
        startTime:      Math.floor(claim.policy.startTime.getTime() / 1000),
        endTime:        Math.floor(claim.policy.endTime.getTime() / 1000),
        status:         claim.policy.status,
      };
    }

    return summary;
  }
}
