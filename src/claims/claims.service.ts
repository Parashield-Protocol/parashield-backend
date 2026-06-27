import { Injectable, Logger, ConflictException, NotFoundException, BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { StellarService } from '../stellar/stellar.service';
import { OracleService } from '../oracle/oracle.service';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { transition } from '../policy/policy-status.machine';

export type ClaimResult = 'Paid' | 'Rejected' | 'Expired' | 'AlreadyClaimed' | 'PolicyNotActive';

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
}

/**
 * ClaimsService — submits and queries claims on the Claims Processor contract.
 *
 * The primary flow is `autoProcess` — triggered by the ClaimsWorker on a schedule.
 * No manual claim filing required for parametric insurance.
 */
@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);

  constructor(
    private readonly stellar: StellarService,
    private readonly oracleService: OracleService,
    private readonly policyService: PolicyService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** Trigger automatic claim evaluation for a policy. */
  async autoProcess(policyId: string): Promise<ClaimResult> {
    this.logger.log(`auto_process policy: ${policyId}`);

    // Fetch policy from DB to verify it exists and is active
    const policy = await this.prisma.policy.findUnique({ where: { id: policyId } });
    if (!policy) {
      this.logger.warn(`Policy ${policyId} not found in DB`);
      return 'PolicyNotActive';
    }

    if (policy.status !== 'ACTIVE') {
      this.logger.warn(`Policy ${policyId} is not ACTIVE (status: ${policy.status})`);
      return 'PolicyNotActive';
    }

    this.logger.log(`Processing claim for policy: id=${policy.id} holder=${policy.policyholder} coverage=${policy.coverageXlm}`);

    // Persist initial claim record with PROCESSING status
    const claim = await this.prisma.claim.create({
      data: {
        policyId,
        claimant:       policy.policyholder,
        coverageAmount: policy.coverageXlm,
        triggerMet:     false,
        status:         'PROCESSING',
      },
    });

    this.logger.log(`Claim record created: id=${claim.id} policyId=${policyId}`);

    // Fetch latest oracle reading for this policy's oracle key
    const reading = await this.oracleService.getLatestReading(policy.oracleKey);
    if (!reading) {
      this.logger.warn(`No oracle reading for key=${policy.oracleKey} — rejecting claim ${claim.id}`);
      await this.prisma.claim.update({
        where: { id: claim.id },
        data:  { status: 'REJECTED', processedAt: new Date() },
      });
      return 'Rejected';
    }

    // Evaluate trigger condition against product definition
    const products   = await this.policyService.getActiveProducts();
    const product    = products.find((p) => p.id === policy.productId);
    const threshold  = BigInt(Math.round(parseFloat(product?.threshold ?? '50') * 1e7));
    const comparison = product?.comparison ?? 'LessThan';

    const triggerMet = comparison === 'LessThan'
      ? reading.value < threshold
      : reading.value > threshold;

    this.logger.log(
      `Trigger eval: key=${reading.key} value=${reading.value} threshold=${threshold} triggerMet=${triggerMet}`,
    );

    if (!triggerMet) {
      await this.prisma.claim.update({
        where: { id: claim.id },
        data:  { status: 'REJECTED', triggerMet: false, processedAt: new Date() },
      });
      return 'Rejected';
    }

    // Trigger met — initiate Soroban payout via Claims Processor contract
    const contractId = this.config.get<string>('CLAIMS_PROCESSOR_CONTRACT') ?? '';
    if (!contractId || !/^C[A-Z2-7]{55}$/.test(contractId)) {
      throw new BadGatewayException(
        'CLAIMS_PROCESSOR_CONTRACT not configured or invalid format. Expected a Stellar contract ID (C...).',
      );
    }

    let txHash: string | undefined;
    try {
      txHash = await this.stellar.invokeContract(
        contractId,
        'process_claim',
        [nativeToScVal(policyId, { type: 'string' })],
      );
      this.logger.log(`Soroban payout initiated: txHash=${txHash} claimId=${claim.id}`);
    } catch (err) {
      this.logger.error(`Soroban payout failed for claim ${claim.id}`, err);
    }

    await this.prisma.claim.update({
      where: { id: claim.id },
      data:  { status: 'PAID', triggerMet: true, processedAt: new Date(), txHash: txHash ?? null, payoutAmount: policy.coverageXlm },
    });

    await this.prisma.policy.update({
      where: { id: policyId },
      data:  { status: transition(policy.status, 'CLAIMED') as any },
    });

    return 'Paid';
  }

  /** Manually submit a claim for a policy (initiated by policyholder). */
  async submitClaim(claimant: string, policyId: string): Promise<string> {
    this.logger.log(`submit_claim: policy=${policyId} claimant=${claimant}`);

    // Duplicate claim guard: prevent double payouts or duplicate in-flight submissions
    const existingClaim = await this.prisma.claim.findFirst({
      where: {
        policyId,
        status: { in: ['PAID', 'PROCESSING', 'PENDING'] },
      },
    });

    if (existingClaim) {
      this.logger.warn(
        `Duplicate claim attempt for policy ${policyId} — existing claim id=${existingClaim.id} status=${existingClaim.status}`,
      );
      throw new ConflictException('Claim already exists for this policy');
    }

    const policy = await this.prisma.policy.findUnique({ where: { id: policyId } });
    if (!policy) {
      throw new NotFoundException(`Policy ${policyId} not found`);
    }
    if (policy.status !== 'ACTIVE') {
      throw new ConflictException(`Policy ${policyId} is not active`);
    }

    const contractId = this.config.get<string>('CLAIMS_PROCESSOR_CONTRACT') ?? '';
    if (!contractId || !/^C[A-Z2-7]{55}$/.test(contractId)) {
      throw new BadGatewayException(
        'CLAIMS_PROCESSOR_CONTRACT not configured or invalid format. Expected a Stellar contract ID (C...).',
      );
    }

    const claim = await this.prisma.claim.create({
      data: {
        policyId,
        claimant,
        coverageAmount: policy.coverageXlm,
        triggerMet:     false,
        status:         'PENDING',
      },
    });

    this.logger.log(`Claim record created: id=${claim.id} policyId=${policyId}`);

    try {
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
      await this.prisma.claim.update({
        where: { id: claim.id },
        data:  { status: 'PROCESSING', txHash },
      });
    } catch (err) {
      this.logger.error(`On-chain submission failed for claim ${claim.id}: ${(err as Error).message}`, err);
      await this.prisma.claim.update({
        where: { id: claim.id },
        data:  { status: 'REJECTED', processedAt: new Date() },
      });
    }

    return claim.id;
  }

  async getClaimsByWallet(walletAddress: string, page = 1, limit = 20): Promise<{ claims: ClaimSummary[]; total: number }> {
    this.logger.log(`get_claims_by_wallet: ${walletAddress} page=${page} limit=${limit}`);
    const [claims, total] = await this.prisma.$transaction([
      this.prisma.claim.findMany({
        where: { claimant: walletAddress },
        orderBy: { submittedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.claim.count({ where: { claimant: walletAddress } }),
    ]);

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
    }));

    return {
      claims: summaries,
      total,
    };
  }

  async getClaim(claimId: string): Promise<ClaimSummary | null> {
    this.logger.log(`get_claim: ${claimId}`);
    const claim = await this.prisma.claim.findUnique({ where: { id: claimId } });
    if (!claim) return null;

    return {
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
    };
  }
}
