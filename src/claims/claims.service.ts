import { Injectable, Logger, ConflictException, NotFoundException, BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { StellarService } from '../stellar/stellar.service';
import { OracleService } from '../oracle/oracle.service';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';

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
      data:  { status: 'CLAIMED' },
    });

    return 'Paid';
  }

  /** Manually submit a claim for a policy (initiated by policyholder). */
  async submitClaim(claimant: string, policyId: string): Promise<string> {
    this.logger.log(`submit_claim: policy=${policyId} claimant=${claimant}`);

    // Duplicate claim guard: prevent double payouts
    const existingClaim = await this.prisma.claim.findFirst({
      where: {
        policyId,
        status: { in: ['PAID', 'PROCESSING'] },
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

    // TODO: build and submit Soroban tx calling claims-processor.submit_claim(...)
    const claim = await this.prisma.claim.create({
      data: {
        policyId,
        claimant,
        coverageAmount: policy.coverageXlm,
        triggerMet:     false,
        status:         'PENDING',
      },
    });

    this.logger.log(`Manual claim submitted: id=${claim.id}`);
    return claim.id;
  }

  async getClaimsByWallet(walletAddress: string): Promise<ClaimSummary[]> {
    this.logger.log(`get_claims_by_wallet: ${walletAddress}`);
    const claims = await this.prisma.claim.findMany({
      where: { claimant: walletAddress },
      orderBy: { submittedAt: 'desc' },
    });

    return claims.map((claim) => ({
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
