import { Injectable, Logger } from '@nestjs/common';
import { StellarService } from '../stellar/stellar.service';
import { PrismaService } from '../prisma/prisma.service';

export type ClaimResult = 'Paid' | 'Rejected' | 'Expired' | 'AlreadyClaimed' | 'PolicyNotActive';

export interface ClaimSummary {
  id:             string;
  policyId:       string;
  claimant:       string;
  coverageAmount: string;
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

    // Persist claim record with PROCESSING status
    // The Soroban tx submission would happen here:
    // await this.stellar.invokeContract(CLAIMS_PROCESSOR_CONTRACT, 'auto_process', [nativeToScVal(policyId, { type: 'string' })]);
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
    return 'Rejected';
  }

  /** Manually submit a claim for a policy (initiated by policyholder). */
  async submitClaim(claimant: string, policyId: string): Promise<string> {
    this.logger.log(`submit_claim: policy=${policyId} claimant=${claimant}`);
    // TODO: build and submit Soroban tx calling claims-processor.submit_claim(...)
    return '0';
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
      triggerMet:     claim.triggerMet,
      status:         claim.status,
      submittedAt:    Math.floor(claim.submittedAt.getTime() / 1000),
      processedAt:    claim.processedAt
        ? Math.floor(claim.processedAt.getTime() / 1000)
        : null,
    };
  }
}
