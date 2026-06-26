import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TransactionBuilder, Transaction } from '@stellar/stellar-sdk';
import { StellarService } from '../stellar/stellar.service';
import { PrismaService } from '../prisma/prisma.service';
import { BuyPolicyDto } from './dto/buy-policy.dto';
import { ConfirmPolicyDto } from './dto/confirm-policy.dto';

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
 * Persists purchased policies to the local PostgreSQL database via PrismaService
 * for fast historical queries and frontend reads.
 */
@Injectable()
export class PolicyService {
  private readonly logger = new Logger(PolicyService.name);

  constructor(
    private readonly stellar: StellarService,
    private readonly prisma: PrismaService,
  ) {}

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

  /**
   * Persist a newly purchased policy to the database.
   * Called after the on-chain transaction is confirmed.
   */
  async createPolicy(dto: BuyPolicyDto | ConfirmPolicyDto, txHash: string) {
    const now = new Date();
    const endTime = new Date(now.getTime() + dto.duration * 24 * 60 * 60 * 1000);

    const product = (await this.getActiveProducts()).find((p) => p.id === dto.productId);
    if (!product) {
      throw new BadRequestException(`Product with ID ${dto.productId} not found or inactive`);
    }

    const validation = this.validateCoverage(dto.coverageXlm, product);
    if (!validation.valid) {
      throw new BadRequestException(validation.reason);
    }

    // Strict validation of oracleKey format based on product category
    if (product.category === 'crop' && !/^rainfall:-?\d+(\.\d+)?,-?\d+(\.\d+)?:20\d{2}-(0[1-9]|1[0-2])$/.test(dto.oracleKey)) {
      throw new BadRequestException('oracleKey format must be rainfall:lat,lng:YYYY-MM for crop products');
    }
    if (product.category === 'flight' && !/^flight:[A-Z0-9]+:20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(dto.oracleKey)) {
      throw new BadRequestException('oracleKey format must be flight:flightNumber:YYYY-MM-DD for flight products');
    }

    const premiumPaid = this.calculatePremium(dto.coverageXlm, product.premiumRate, dto.duration);

    const policy = await this.prisma.policy.create({
      data: {
        productId:    dto.productId,
        policyholder: dto.walletAddress,
        coverageXlm:  dto.coverageXlm,
        premiumPaid,
        oracleKey:    dto.oracleKey,
        startTime:    now,
        endTime,
        status:       'ACTIVE',
        txHash,
      },
    });

    this.logger.log(`Policy created: id=${policy.id} holder=${dto.walletAddress}`);
    return policy;
  }

  /**
   * Submit a signed XDR transaction to the network and persist the policy.
   * Returns the on-chain policyId and txHash on success.
   */
  async confirmAndCreatePolicy(dto: ConfirmPolicyDto): Promise<{ policyId: string; txHash: string }> {
    const tx = TransactionBuilder.fromXDR(dto.signedXdr, this.stellar.networkPassphrase) as Transaction;
    const sendResult = await this.stellar.rpcServer.sendTransaction(tx);
    if (sendResult.status === 'ERROR') {
      throw new Error(`On-chain submission failed: ${JSON.stringify(sendResult.errorResult)}`);
    }
    const policy = await this.createPolicy(dto, sendResult.hash);
    this.logger.log(`Policy confirmed on-chain: id=${policy.id} txHash=${sendResult.hash}`);
    return { policyId: policy.id, txHash: sendResult.hash };
  }

  /**
   * Find all policies for a policyholder from the local database.
   */
  async findByPolicyholder(address: string) {
    const policies = await this.prisma.policy.findMany({
      where: { policyholder: address },
      orderBy: { createdAt: 'desc' },
    });
    this.logger.log(`findByPolicyholder: ${address} → ${policies.length} policies`);
    return policies;
  }

  async getActiveProducts(): Promise<ProductSummary[]> {
    this.logger.log('get_active_products called');
    const dbProducts = await this.prisma.product.findMany({
      where: { status: 'Active' },
    });
    return dbProducts.map((product) => ({
      id:          product.id,
      name:        product.name,
      category:    product.category,
      triggerType: product.triggerType,
      threshold:   product.threshold,
      comparison:  product.comparison,
      coverageMin: product.coverageMin,
      coverageMax: product.coverageMax,
      premiumRate: product.premiumRate,
      maxDuration: product.maxDuration,
      status:      product.status,
    }));
  }

  async getPolicy(policyId: string): Promise<PolicySummary | null> {
    this.logger.log(`get_policy: ${policyId}`);
    // Try database first
    const dbPolicy = await this.prisma.policy.findUnique({ where: { id: policyId } });
    if (dbPolicy) {
      return {
        id:           dbPolicy.id,
        productId:    dbPolicy.productId,
        policyholder: dbPolicy.policyholder,
        coverage:     dbPolicy.coverageXlm.toString(),
        premiumPaid:  dbPolicy.premiumPaid.toString(),
        oracleKey:    dbPolicy.oracleKey,
        startTime:    Math.floor(dbPolicy.startTime.getTime() / 1000),
        endTime:      Math.floor(dbPolicy.endTime.getTime() / 1000),
        status:       dbPolicy.status,
      };
    }
    // TODO: fall back to policy-engine.get_policy(policy_id) via stellar.simulateInvoke
    return null;
  }

  async getUserPolicies(walletAddress: string): Promise<PolicySummary[]> {
    this.logger.log(`get_user_policies: ${walletAddress}`);
    const dbPolicies = await this.findByPolicyholder(walletAddress);
    return dbPolicies.map((p) => ({
      id:           p.id,
      productId:    p.productId,
      policyholder: p.policyholder,
      coverage:     p.coverageXlm.toString(),
      premiumPaid:  p.premiumPaid.toString(),
      oracleKey:    p.oracleKey,
      startTime:    Math.floor(p.startTime.getTime() / 1000),
      endTime:      Math.floor(p.endTime.getTime() / 1000),
      status:       p.status,
    }));
  }
}
