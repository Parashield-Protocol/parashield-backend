import { BadRequestException, ConflictException, GoneException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TransactionBuilder, Transaction, Address, rpc as StellarRpc, scValToNative, nativeToScVal } from '@stellar/stellar-sdk';
import { StellarService } from '../stellar/stellar.service';
import { PrismaService } from '../prisma/prisma.service';
import { BuyPolicyDto } from './dto/buy-policy.dto';
import { ConfirmPolicyDto } from './dto/confirm-policy.dto';
import { ConfigService } from '@nestjs/config';

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

export interface OracleKeyValidationResult {
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
    private readonly config: ConfigService,
  ) {}

  /**
   * Calculate the premium for a policy in XLM (whole number, rounded up).
   * Uses basis points: premiumRate 500 = 5%, 100 = 1%.
   *
   * Duration is pro-rated against a 30-day base period to match the
   * PolicyEngine contract's on-chain formula:
   *   premium = ceil(coverage * rate * duration / (10000 * 30))
   */
  calculatePremium(coverageXlm: number, premiumRate: number, durationDays: number): number {
    return Math.ceil(coverageXlm * premiumRate * durationDays / (10000 * 30));
  }

  /**
   * Validate the oracleKey format for a given product category.
   * Called during quote generation (buyPolicy) so errors are surfaced immediately.
   */
  validateOracleKey(oracleKey: string, product: ProductSummary): OracleKeyValidationResult {
    if (
      product.category === 'crop' &&
      !/^rainfall:-?\d+(\.\d+)?,-?\d+(\.\d+)?:20\d{2}-(0[1-9]|1[0-2])$/.test(oracleKey)
    ) {
      return {
        valid: false,
        reason: 'oracleKey format must be rainfall:lat,lng:YYYY-MM for crop products',
      };
    }
    if (
      product.category === 'flight' &&
      !/^flight:[A-Z0-9]+:20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(oracleKey)
    ) {
      return {
        valid: false,
        reason: 'oracleKey format must be flight:flightNumber:YYYY-MM-DD for flight products',
      };
    }
    return { valid: true };
  }

  /**
   * Read the available liquidity from the Risk Pool.
   * We query the USDC token contract's `balance` entry-point for the
   * POLICY_ENGINE_CONTRACT account, which holds the pooled collateral.
   * Returns the balance as a number (in XLM-equivalent units, 7-decimal fixed point).
   * Returns Infinity when the contract is not configured so tests are unaffected.
   */
  async getPoolAvailableBalance(): Promise<number> {
    const usdcContract = this.config.get<string>('USDC_CONTRACT');
    const policyEngineContract = this.config.get<string>('POLICY_ENGINE_CONTRACT');

    if (!usdcContract || !policyEngineContract) {
      this.logger.warn('USDC_CONTRACT or POLICY_ENGINE_CONTRACT not configured — skipping pool balance check');
      return Infinity;
    }

    try {
      const engineAddress = nativeToScVal(policyEngineContract, { type: 'address' });
      const simResult = await this.stellar.simulateInvoke(usdcContract, 'balance', [engineAddress]);

      if (StellarRpc.Api.isSimulationError(simResult)) {
        this.logger.warn(`Pool balance simulation error: ${(simResult as any).error}`);
        return Infinity;
      }

      const raw = (simResult as StellarRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
      if (!raw) {
        this.logger.warn('Pool balance simulation returned no result');
        return Infinity;
      }

      const balance = Number(scValToNative(raw));
      this.logger.log(`Pool available balance: ${balance} (7-decimal fixed point)`);
      return balance;
    } catch (err) {
      this.logger.warn(`Failed to fetch pool balance: ${(err as Error).message}`);
      return Infinity;
    }
  }

  /**
   * Validate that a coverage amount falls within the product's allowed range
   * AND does not exceed the pool's available liquidity.
   *
   * Also validates the oracleKey format for the product category so errors
   * are surfaced at quote time (#132).
   */
  async validateCoverage(
    coverageXlm: number,
    product: ProductSummary,
    oracleKey?: string,
  ): Promise<PremiumValidationResult> {
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

    // #131 — Reject if coverage exceeds available pool liquidity
    const poolBalance = await this.getPoolAvailableBalance();
    if (coverageXlm > poolBalance) {
      return {
        valid: false,
        reason: `Coverage ${coverageXlm} XLM exceeds the pool's available liquidity (${poolBalance} XLM)`,
      };
    }

    // #132 — Validate oracleKey format at quote time if provided
    if (oracleKey !== undefined) {
      const keyValidation = this.validateOracleKey(oracleKey, product);
      if (!keyValidation.valid) {
        return { valid: false, reason: keyValidation.reason };
      }
    }

    return { valid: true };
  }

  /**
   * Validate that the requested coverage does not exceed the pool's available liquidity.
   * Skipped when POOL_CAPACITY_XLM is not configured.
   */
  async validatePoolCapacity(coverageXlm: number): Promise<void> {
    const poolCapacity = parseFloat(this.config.get<string>('POOL_CAPACITY_XLM') ?? '0');
    if (poolCapacity <= 0) return;

    const result = await this.prisma.policy.aggregate({
      _sum: { coverageXlm: true },
      where: { status: 'ACTIVE' },
    });

    const committed = result._sum.coverageXlm ? parseFloat(result._sum.coverageXlm.toString()) : 0;
    const available = poolCapacity - committed;

    if (coverageXlm > available) {
      throw new BadRequestException(
        `Requested coverage ${coverageXlm} XLM exceeds available pool capacity of ${available.toFixed(7)} XLM`,
      );
    }
  }

  /**
   * Persist a newly purchased policy to the database.
   * Called after the on-chain transaction is confirmed.
   */
  async createPolicy(dto: BuyPolicyDto | ConfirmPolicyDto, txHash: string) {
    // Use Unix seconds to avoid millisecond rounding vs Soroban contract timestamps (#113)
    const nowSeconds = Math.floor(Date.now() / 1000);
    const endTimeSeconds = nowSeconds + dto.duration * 24 * 3600;
    const now = new Date(nowSeconds * 1000);
    const endTime = new Date(endTimeSeconds * 1000);

    const product = (await this.getActiveProducts()).find((p) => p.id === dto.productId);
    if (!product) {
      throw new BadRequestException(`Product with ID ${dto.productId} not found or inactive`);
    }

    // validateCoverage now also checks pool liquidity (#131) and oracleKey format (#132)
    const validation = await this.validateCoverage(dto.coverageXlm, product, dto.oracleKey);
    if (!validation.valid) {
      throw new BadRequestException(validation.reason);
    }

    const premiumPaid = this.calculatePremium(dto.coverageXlm, product.premiumRate, dto.duration);

    try {
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
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(
          'An active policy already exists for this wallet, product, and oracle key',
        );
      }
      throw err;
    }
  }

  /**
   * Submit a signed XDR transaction to the network and persist the policy.
   *
   * Flow:
   *   1. Deserialize the frontend-signed XDR
   *   2. Validate timeBounds.maxTime has not expired
   *   3. Simulate → assembleTransaction → sign (keeper) → sendTransaction
   *   4. Poll getTransaction until SUCCESS or FAILED
   *   5. Create policy record only on SUCCESS
   *
   * Returns the on-chain policyId and txHash on success.
   */
  async confirmAndCreatePolicy(dto: ConfirmPolicyDto, authenticatedWallet: string): Promise<{ policyId: string; txHash: string }> {
    const tx = TransactionBuilder.fromXDR(dto.signedXdr, this.stellar.networkPassphrase) as Transaction;

    // Reject XDRs with no timeBounds or an expired maxTime (#102)
    const nowSeconds = Math.floor(Date.now() / 1000);
    const maxTime = tx.timeBounds?.maxTime ? parseInt(tx.timeBounds.maxTime, 10) : 0;
    if (maxTime <= 0 || maxTime < nowSeconds) {
      throw new GoneException('Signed XDR has expired; please request a new transaction to sign');
    }

    // Validate XDR source matches both the JWT-verified wallet and the DTO field (#112)
    if (tx.source !== authenticatedWallet) {
      throw new BadRequestException(
        `Transaction source account (${tx.source}) does not match the authenticated wallet (${authenticatedWallet})`
      );
    }
    if (tx.source !== dto.walletAddress) {
      throw new BadRequestException(
        `Transaction source account (${tx.source}) does not match the wallet address in the request (${dto.walletAddress})`
      );
    }

    // Validate there is at least one operation
    if (!tx.operations || tx.operations.length === 0) {
      throw new BadRequestException('Transaction must contain at least one operation');
    }

    const firstOp = tx.operations[0];

    // Validate it is invokeContractFunction (invokeHostFunction in SDK)
    if (firstOp.type !== 'invokeHostFunction') {
      throw new BadRequestException(
        `Expected first operation type to be invokeHostFunction, got ${firstOp.type}`
      );
    }

    const hostFunc = (firstOp as any).func;
    if (!hostFunc || hostFunc.switch().name !== 'hostFunctionTypeInvokeContract') {
      throw new BadRequestException('Transaction does not invoke a contract function');
    }

    const invokeContract = hostFunc.invokeContract();
    
    let contractIdStr: string;
    try {
      contractIdStr = Address.fromScAddress(invokeContract.contractAddress()).toString();
    } catch (e) {
      throw new BadRequestException('Invalid contract address in transaction');
    }

    const expectedContract = this.config.get<string>('POLICY_ENGINE_CONTRACT');
    if (!expectedContract) {
      throw new BadRequestException('POLICY_ENGINE_CONTRACT is not configured on the server');
    }

    if (contractIdStr !== expectedContract) {
      throw new BadRequestException(
        `Transaction targets contract ${contractIdStr}, expected POLICY_ENGINE_CONTRACT (${expectedContract})`
      );
    }

    const functionName = invokeContract.functionName().toString();
    if (functionName !== 'buy_policy') {
      throw new BadRequestException(
        `Transaction calls function '${functionName}', expected 'buy_policy'`
      );
    }

    // Validate XDR args match the expected DTO parameters (#122).
    // buy_policy(product_id: String, coverage: i128, oracle_key: String)
    const args = invokeContract.args();
    if (!args || args.length < 3) {
      throw new BadRequestException('buy_policy transaction must have at least 3 arguments (product_id, coverage, oracle_key)');
    }
    try {
      const xdrProductId  = String(scValToNative(args[0]));
      const xdrCoverage   = String(scValToNative(args[1]));
      const xdrOracleKey  = String(scValToNative(args[2]));

      if (xdrProductId !== dto.productId) {
        throw new BadRequestException(
          `XDR productId (${xdrProductId}) does not match request productId (${dto.productId})`
        );
      }
      if (xdrCoverage !== String(dto.coverageXlm)) {
        throw new BadRequestException(
          `XDR coverage (${xdrCoverage}) does not match request coverage (${dto.coverageXlm})`
        );
      }
      if (xdrOracleKey !== dto.oracleKey) {
        throw new BadRequestException(
          `XDR oracleKey (${xdrOracleKey}) does not match request oracleKey (${dto.oracleKey})`
        );
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException('Failed to decode buy_policy arguments from XDR');
    }

    const sendResult = await this.stellar.simulateAssembleAndSend(tx);
    if (sendResult.status === 'ERROR') {
      throw new Error(`On-chain submission failed: ${JSON.stringify(sendResult.errorResult)}`);
    }

    this.logger.log(`Transaction submitted: txHash=${sendResult.hash} status=${sendResult.status}`);

    if (sendResult.status === 'TRY_AGAIN_LATER' || sendResult.status === 'PENDING') {
      const txResult = await this.stellar.waitForTransaction(sendResult.hash);
      if (!txResult || txResult.status !== 'SUCCESS') {
        throw new BadRequestException(`Transaction ${sendResult.hash} did not confirm on-chain`);
      }
      this.logger.log(`Transaction confirmed on-chain: txHash=${sendResult.hash}`);
    }

    const policy = await this.createPolicy(dto, sendResult.hash);
    this.logger.log(`Policy created: id=${policy.id} txHash=${sendResult.hash}`);
    return { policyId: policy.id, txHash: sendResult.hash };
  }

  /**
   * Find policies for a policyholder from the local database with pagination.
   */
  async findByPolicyholder(address: string, page: number = 1, limit: number = 20) {
    const take = Math.min(limit, 100);
    const skip = (page - 1) * take;

    const [policies, total] = await Promise.all([
      this.prisma.policy.findMany({
        where: { policyholder: address },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.policy.count({ where: { policyholder: address } }),
    ]);

    this.logger.log(`findByPolicyholder: ${address} → ${policies.length}/${total} policies (page ${page})`);
    return { policies, total };
  }

  async getProductById(id: string): Promise<ProductSummary | null> {
    const product = await this.prisma.product.findUnique({
      where: { id, status: 'Active' },
    });
    if (!product) return null;
    return {
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
    };
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

  async getUserPolicies(
    walletAddress: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<{ data: PolicySummary[]; total: number; page: number; limit: number }> {
    this.logger.log(`get_user_policies: ${walletAddress} page=${page} limit=${limit}`);
    const clampedLimit = Math.min(limit, 100);
    const { policies: dbPolicies, total } = await this.findByPolicyholder(walletAddress, page, clampedLimit);
    const data = dbPolicies.map((p) => ({
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
    return { data, total, page, limit: clampedLimit };
  }
}
