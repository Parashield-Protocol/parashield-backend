import { Injectable, Logger } from '@nestjs/common';
import { StellarService } from '../stellar/stellar.service';

export interface ProductSummary {
  id:           string;
  name:         string;
  category:     string;
  triggerType:  string;
  threshold:    string;
  comparison:   string;
  coverageMin:  string;
  coverageMax:  string;
  premiumRate:  number;
  maxDuration:  number;
  status:       string;
}

export interface PolicySummary {
  id:             string;
  productId:      string;
  policyholder:   string;
  coverage:       string;
  premiumPaid:    string;
  oracleKey:      string;
  startTime:      number;
  endTime:        number;
  status:         string;
}

export interface PremiumValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * PolicyService — reads policy and product data from the Policy Engine contract.
 *
 * In v1 all reads are simulated via Stellar RPC (no local DB mirror).
 * A future iteration will index contract events into PostgreSQL for
 * faster queries and historical analytics.
 */
@Injectable()
export class PolicyService {
  private readonly logger = new Logger(PolicyService.name);

  constructor(private readonly stellar: StellarService) {}

  /**
   * Calculate the premium for a policy in XLM (whole number, rounded up).
   * Uses basis points: premiumRate 500 = 5%, 100 = 1%.
   * Formula: coverage * rate * (duration / 365) / 10000
   */
  calculatePremium(coverageXlm: number, premiumRate: number, durationDays: number): number {
    return Math.ceil(coverageXlm * premiumRate * (durationDays / 365) / 10000);
  }

  /**
   * Validate that a coverage amount falls within the product's allowed range.
   */
  validateCoverage(coverageXlm: number, product: ProductSummary): PremiumValidationResult {
    const min = parseFloat(product.coverageMin);
    const max = parseFloat(product.coverageMax);

    if (coverageXlm < min) {
      return {
        valid: false,
        reason: `Coverage ${coverageXlm} XLM is below the minimum ${min} XLM for this product`,
      };
    }

    if (coverageXlm > max) {
      return {
        valid: false,
        reason: `Coverage ${coverageXlm} XLM exceeds the maximum ${max} XLM for this product`,
      };
    }

    return { valid: true };
  }

  async getActiveProducts(): Promise<ProductSummary[]> {
    // TODO: call policy-engine.get_active_products() via stellar.simulateInvoke
    // Returns mock data in v1 until contract integration is wired
    this.logger.log('get_active_products called');
    return [
      {
        id:          '1',
        name:        'Crop Insurance – Kisumu Rainfall',
        category:    'crop',
        triggerType: 'Threshold',
        threshold:   '50.0000000',
        comparison:  'LessThan',
        coverageMin: '10.0000000',
        coverageMax: '1000.0000000',
        premiumRate: 500,
        maxDuration: 365,
        status:      'Active',
      },
    ];
  }

  async getPolicy(policyId: string): Promise<PolicySummary | null> {
    this.logger.log(`get_policy: ${policyId}`);
    // TODO: call policy-engine.get_policy(policy_id) via stellar.simulateInvoke
    return null;
  }

  async getUserPolicies(walletAddress: string): Promise<PolicySummary[]> {
    this.logger.log(`get_user_policies: ${walletAddress}`);
    // TODO: call policy-engine.get_user_policies(user) via stellar.simulateInvoke
    return [];
  }
}
