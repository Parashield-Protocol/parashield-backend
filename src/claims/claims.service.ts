import { Injectable, Logger } from '@nestjs/common';
import { StellarService } from '../stellar/stellar.service';

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

  constructor(private readonly stellar: StellarService) {}

  /** Trigger automatic claim evaluation for a policy. */
  async autoProcess(policyId: string): Promise<ClaimResult> {
    this.logger.log(`auto_process policy: ${policyId}`);
    // TODO: build and submit Soroban tx calling claims-processor.auto_process(policy_id)
    // via stellar.rpcServer.sendTransaction(...)
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
    return null;
  }
}
