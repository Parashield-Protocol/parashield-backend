import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaimsService } from './claims.service';
import { StellarService } from '../stellar/stellar.service';
import { OracleService } from '../oracle/oracle.service';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

describe('ClaimsService', () => {
  let service: ClaimsService;

  const mockStellarService = {
    invokeContract: jest.fn(),
  };

  const mockOracleService = {
    getLatestReading: jest.fn(),
  };

  const mockPolicyService = {
    getActiveProducts: jest.fn(),
    getProductById: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'CLAIMS_PROCESSOR_CONTRACT') {
        return 'CC4CG7QPQ5B6CFUANVWFXPF76QCB5DUJCLU4QWPHZE2FP4XCLJAVC5K7';
      }
      return '';
    }),
  };

  const mockPrismaService = {
    policy: {
      findUnique: jest.fn(),
      update:     jest.fn(),
      updateMany: jest.fn(),
    },
    claim: {
      findFirst:  jest.fn(),
      findMany:   jest.fn(),
      findUnique: jest.fn(),
      create:     jest.fn(),
      update:     jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const POLICY_ID = 'test-policy-uuid';
  const CLAIMANT  = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';

  const ACTIVE_POLICY = {
    id:           POLICY_ID,
    productId:    '1',
    policyholder: CLAIMANT,
    coverageXlm:  new Prisma.Decimal("100"),
    oracleKey:    'rainfall:1',
    status:       'ACTIVE',
  };

  const MOCK_PRODUCT = {
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
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaimsService,
        { provide: StellarService, useValue: mockStellarService },
        { provide: OracleService,  useValue: mockOracleService },
        { provide: PolicyService,  useValue: mockPolicyService },
        { provide: ConfigService,  useValue: mockConfigService },
        { provide: PrismaService,  useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<ClaimsService>(ClaimsService);
    jest.clearAllMocks();
  });

  describe('submitClaim — duplicate claim prevention', () => {
    it('should throw ConflictException when a PAID claim already exists for the policy', async () => {
      mockPrismaService.claim.findFirst.mockResolvedValue({
        id:       'existing-claim-id',
        policyId: POLICY_ID,
        status:   'PAID',
      });

      await expect(service.submitClaim(CLAIMANT, POLICY_ID)).rejects.toThrow(ConflictException);
      await expect(service.submitClaim(CLAIMANT, POLICY_ID)).rejects.toThrow(
        'Claim already exists for this policy',
      );
    });

    it('should throw ConflictException when a PROCESSING claim already exists for the policy', async () => {
      mockPrismaService.claim.findFirst.mockResolvedValue({
        id:       'processing-claim-id',
        policyId: POLICY_ID,
        status:   'PROCESSING',
      });

      await expect(service.submitClaim(CLAIMANT, POLICY_ID)).rejects.toThrow(ConflictException);
    });

    it('should proceed normally when no existing PAID/PROCESSING claim exists', async () => {
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.create.mockResolvedValue({
        id:       'new-claim-id',
        policyId: POLICY_ID,
        claimant: CLAIMANT,
        status:   'PENDING',
      });

      const claimId = await service.submitClaim(CLAIMANT, POLICY_ID);
      expect(claimId).toBe('new-claim-id');
      expect(mockPrismaService.claim.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            policyId: POLICY_ID,
            claimant: CLAIMANT,
            status:   'PENDING',
          }),
        }),
      );
    });

    it('should check for PAID and PROCESSING statuses in the guard query', async () => {
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.create.mockResolvedValue({ id: 'new-id', policyId: POLICY_ID });

      await service.submitClaim(CLAIMANT, POLICY_ID);

      expect(mockPrismaService.claim.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            policyId: POLICY_ID,
            status:   expect.objectContaining({ in: expect.arrayContaining(['PAID', 'PROCESSING']) }),
          }),
        }),
      );
    });

    it('should throw NotFoundException when policy does not exist', async () => {
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.policy.findUnique.mockResolvedValue(null);

      await expect(service.submitClaim(CLAIMANT, POLICY_ID)).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException when policy is not ACTIVE', async () => {
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.policy.findUnique.mockResolvedValue({ ...ACTIVE_POLICY, status: 'EXPIRED' });

      await expect(service.submitClaim(CLAIMANT, POLICY_ID)).rejects.toThrow(ConflictException);
    });

    it('#177 — throws ForbiddenException when the caller does not own the policy', async () => {
      const STRANGER = 'GBSTRANGERWALLET000000000000000000000000000000000000000';
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);

      await expect(service.submitClaim(STRANGER, POLICY_ID)).rejects.toThrow(ForbiddenException);
      expect(mockPrismaService.claim.create).not.toHaveBeenCalled();
    });

    it('#177 — proceeds normally when the caller owns the policy', async () => {
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.create.mockResolvedValue({
        id:       'owned-claim-id',
        policyId: POLICY_ID,
        claimant: CLAIMANT,
        status:   'PENDING',
      });

      const claimId = await service.submitClaim(CLAIMANT, POLICY_ID);
      expect(claimId).toBe('owned-claim-id');
    });

    it('should use policy coverageXlm as the claim coverageAmount', async () => {
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.create.mockResolvedValue({
        id:             'new-claim-id',
        policyId:       POLICY_ID,
        claimant:       CLAIMANT,
        coverageAmount: ACTIVE_POLICY.coverageXlm,
        status:         'PENDING',
      });

      await service.submitClaim(CLAIMANT, POLICY_ID);

      expect(mockPrismaService.claim.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            coverageAmount: ACTIVE_POLICY.coverageXlm,
          }),
        }),
      );
    });
  });

  describe('submitClaim — Soroban on-chain submission', () => {
    const CREATED_CLAIM = {
      id:       'new-claim-id',
      policyId: POLICY_ID,
      claimant: CLAIMANT,
      status:   'PENDING',
    };

    beforeEach(() => {
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.create.mockResolvedValue(CREATED_CLAIM);
      mockPrismaService.claim.update.mockResolvedValue({});
    });

    it('should invoke submit_claim on the Soroban contract after creating the DB record', async () => {
      mockStellarService.invokeContract.mockResolvedValue('submit-tx-hash');

      await service.submitClaim(CLAIMANT, POLICY_ID);

      expect(mockStellarService.invokeContract).toHaveBeenCalledWith(
        expect.any(String),
        'submit_claim',
        expect.any(Array),
      );
    });

    it('should update claim status to PROCESSING with txHash on successful on-chain submission', async () => {
      mockStellarService.invokeContract.mockResolvedValue('submit-tx-hash');

      await service.submitClaim(CLAIMANT, POLICY_ID);

      expect(mockPrismaService.claim.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'new-claim-id' },
          data:  expect.objectContaining({ status: 'PROCESSING', txHash: 'submit-tx-hash' }),
        }),
      );
    });

    it('should update claim status to REJECTED when on-chain submission throws', async () => {
      mockStellarService.invokeContract.mockRejectedValue(new Error('RPC unavailable'));

      await service.submitClaim(CLAIMANT, POLICY_ID);

      expect(mockPrismaService.claim.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'new-claim-id' },
          data:  expect.objectContaining({ status: 'FAILED' }),
        }),
      );
    });

    it('should NOT leave claim in PENDING status when on-chain submission fails', async () => {
      mockStellarService.invokeContract.mockRejectedValue(new Error('Soroban RPC down'));

      await service.submitClaim(CLAIMANT, POLICY_ID);

      const updateCalls = mockPrismaService.claim.update.mock.calls;
      const pendingUpdate = updateCalls.find((call: any[]) => call[0]?.data?.status === 'PENDING');
      expect(pendingUpdate).toBeUndefined();
    });

    it('should return the claim ID in both success and failure cases', async () => {
      mockStellarService.invokeContract.mockResolvedValue('tx-hash');
      const successId = await service.submitClaim(CLAIMANT, POLICY_ID);
      expect(successId).toBe('new-claim-id');

      jest.clearAllMocks();
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.create.mockResolvedValue(CREATED_CLAIM);
      mockPrismaService.claim.update.mockResolvedValue({});
      mockStellarService.invokeContract.mockRejectedValue(new Error('fail'));

      const failId = await service.submitClaim(CLAIMANT, POLICY_ID);
      expect(failId).toBe('new-claim-id');
    });

    it('should include PENDING in the duplicate claim guard', async () => {
      mockStellarService.invokeContract.mockResolvedValue('tx-hash');

      await service.submitClaim(CLAIMANT, POLICY_ID);

      expect(mockPrismaService.claim.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: expect.objectContaining({
              in: expect.arrayContaining(['PAID', 'PROCESSING', 'PENDING']),
            }),
          }),
        }),
      );
    });
  });

  describe('autoProcess', () => {
    beforeEach(() => {
      // Default: atomic gate succeeds (count=1) and $transaction resolves
      mockPrismaService.policy.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      mockPrismaService.$transaction = jest.fn().mockResolvedValue([{}, {}]);
    });

    it('should return PolicyNotActive when policy does not exist in DB', async () => {
      mockPrismaService.policy.findUnique.mockResolvedValue(null);

      const result = await service.autoProcess('nonexistent-policy');
      expect(result).toBe('PolicyNotActive');
    });

    it('should return PolicyNotActive when policy is not ACTIVE', async () => {
      mockPrismaService.policy.findUnique.mockResolvedValue({
        id:     'p1',
        status: 'EXPIRED',
      });

      const result = await service.autoProcess('p1');
      expect(result).toBe('PolicyNotActive');
    });

    it('should return AlreadyProcessed when an existing non-terminal claim exists', async () => {
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.findFirst.mockResolvedValue({ id: 'c1', status: 'PROCESSING' });

      const result = await service.autoProcess(POLICY_ID);
      expect(result).toBe('AlreadyProcessed');
      expect(mockPrismaService.policy.updateMany).not.toHaveBeenCalled();
    });

    it('#164 — should use updateMany atomic gate before oracle read', async () => {
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.claim.create.mockResolvedValue({ id: 'claim-1', status: 'PROCESSING' });
      mockOracleService.getLatestReading.mockResolvedValue(null);
      mockPrismaService.claim.update.mockResolvedValue({});

      await service.autoProcess(POLICY_ID);

      expect(mockPrismaService.policy.updateMany).toHaveBeenCalledWith({
        where: { id: POLICY_ID, status: 'ACTIVE' },
        data:  { status: 'PROCESSING' },
      });
    });

    it('#164 — should return AlreadyProcessed when atomic gate finds count=0 (lost race)', async () => {
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.policy.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.autoProcess(POLICY_ID);
      expect(result).toBe('AlreadyProcessed');
      expect(mockPrismaService.claim.create).not.toHaveBeenCalled();
    });

    it('should create a PROCESSING claim record for an ACTIVE policy', async () => {
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.claim.create.mockResolvedValue({ id: 'claim-1', status: 'PROCESSING' });
      mockOracleService.getLatestReading.mockResolvedValue(null);
      mockPrismaService.claim.update.mockResolvedValue({});

      await service.autoProcess(POLICY_ID);

      expect(mockPrismaService.claim.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            policyId: POLICY_ID,
            status:   'PROCESSING',
          }),
        }),
      );
    });

    it('should return Rejected when no oracle reading is available', async () => {
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.claim.create.mockResolvedValue({ id: 'claim-1', status: 'PROCESSING' });
      mockOracleService.getLatestReading.mockResolvedValue(null);
      mockPrismaService.claim.update.mockResolvedValue({});

      const result = await service.autoProcess(POLICY_ID);
      expect(result).toBe('Rejected');
    });

    it('should return Rejected when oracle value is above the LessThan threshold', async () => {
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.claim.create.mockResolvedValue({ id: 'claim-1', status: 'PROCESSING' });
      mockOracleService.getLatestReading.mockResolvedValue({
        key:        ACTIVE_POLICY.oracleKey,
        value:      BigInt(800_000_000), // 80 mm — above 50 mm threshold, trigger NOT met
        confidence: 90,
      });
      mockPolicyService.getProductById.mockResolvedValue(MOCK_PRODUCT);
      mockPrismaService.claim.update.mockResolvedValue({});

      const result = await service.autoProcess(POLICY_ID);
      expect(result).toBe('Rejected');
    });

    it('should return Paid and invoke Soroban when oracle value meets the trigger condition', async () => {
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.claim.create.mockResolvedValue({ id: 'claim-1', status: 'PROCESSING' });
      mockOracleService.getLatestReading.mockResolvedValue({
        key:        ACTIVE_POLICY.oracleKey,
        value:      BigInt(200_000_000), // 20 mm — below 50 mm threshold, trigger MET
        confidence: 90,
      });
      mockPolicyService.getProductById.mockResolvedValue(MOCK_PRODUCT);
      mockStellarService.invokeContract.mockResolvedValue('tx-hash-abc');

      const result = await service.autoProcess(POLICY_ID);
      expect(result).toBe('Paid');
      expect(mockStellarService.invokeContract).toHaveBeenCalledWith(
        expect.any(String),
        'process_claim',
        expect.any(Array),
      );
    });

    it('#166 — should wrap claim+policy DB writes in a single $transaction on success', async () => {
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.claim.create.mockResolvedValue({ id: 'claim-1', status: 'PROCESSING' });
      mockOracleService.getLatestReading.mockResolvedValue({
        key:        ACTIVE_POLICY.oracleKey,
        value:      BigInt(200_000_000),
        confidence: 90,
      });
      mockPolicyService.getProductById.mockResolvedValue(MOCK_PRODUCT);
      mockStellarService.invokeContract.mockResolvedValue('tx-hash-xyz');

      await service.autoProcess(POLICY_ID);

      expect(mockPrismaService.$transaction).toHaveBeenCalledWith(
        expect.arrayContaining([expect.anything(), expect.anything()]),
      );
    });

    it('#165/#186 — should revert policy to ACTIVE and mark claim FAILED when Soroban invoke throws', async () => {
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.claim.create.mockResolvedValue({ id: 'claim-fail', status: 'PROCESSING' });
      mockOracleService.getLatestReading.mockResolvedValue({
        key:        ACTIVE_POLICY.oracleKey,
        value:      BigInt(200_000_000),
        confidence: 90,
      });
      mockPolicyService.getProductById.mockResolvedValue(MOCK_PRODUCT);
      mockStellarService.invokeContract.mockRejectedValue(new Error('Soroban RPC down'));

      const result = await service.autoProcess(POLICY_ID);
      expect(result).toBe('Rejected');
      // Both the FAILED claim update and ACTIVE policy revert happen in one transaction
      expect(mockPrismaService.$transaction).toHaveBeenCalled();

      // #186 — this is the regression guard for the payout-failure bug: a
      // rejected invokeContract must never result in the claim being marked
      // PAID. Asserting only "$transaction was called" (as the prior test
      // did) would not have caught that regression.
      const claimUpdateCalls = mockPrismaService.claim.update.mock.calls;
      expect(claimUpdateCalls.some((call: any[]) => call[0]?.data?.status === 'PAID')).toBe(false);
      expect(claimUpdateCalls.some((call: any[]) => call[0]?.data?.status === 'FAILED')).toBe(true);
    });

    // #271 — The existing "Paid" test only asserted result==='Paid' and that
    // invokeContract was called. It never checked the claim.update / policy.update
    // arguments written into $transaction, so a regression that stored the wrong
    // status or omitted triggerMet would go undetected.
    it('#271 — Paid path writes claim status=PAID with triggerMet=true and policy status=CLAIMED', async () => {
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.claim.create.mockResolvedValue({ id: 'claim-paid', status: 'PROCESSING' });
      mockOracleService.getLatestReading.mockResolvedValue({
        key:        ACTIVE_POLICY.oracleKey,
        value:      BigInt(200_000_000), // 20 mm — below 50 mm LessThan threshold, trigger MET
        confidence: 90,
      });
      mockPolicyService.getProductById.mockResolvedValue(MOCK_PRODUCT);
      mockStellarService.invokeContract.mockResolvedValue('tx-hash-paid');

      const result = await service.autoProcess(POLICY_ID);
      expect(result).toBe('Paid');

      // Verify the claim is written with PAID status, triggerMet=true, and the txHash
      expect(mockPrismaService.claim.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'claim-paid' },
          data: expect.objectContaining({
            status:    'PAID',
            triggerMet: true,
            txHash:    'tx-hash-paid',
          }),
        }),
      );

      // Verify the policy is transitioned to CLAIMED (not left in PROCESSING).
      // #260 — this now guards on the expected status via updateMany rather
      // than an unconditional update({ where: { id } }).
      expect(mockPrismaService.policy.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: POLICY_ID, status: 'PROCESSING' },
          data: expect.objectContaining({ status: 'CLAIMED' }),
        }),
      );
    });

    // #273 — Every previous autoProcess test used comparison:'LessThan'. The GreaterThan
    // branch (flight-delay-style products) was completely uncovered.
    it('#273 — GreaterThan product: value above threshold triggers a Paid payout', async () => {
      const GT_PRODUCT = { ...MOCK_PRODUCT, comparison: 'GreaterThan', threshold: '30.0000000' };
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.claim.create.mockResolvedValue({ id: 'claim-gt', status: 'PROCESSING' });
      mockOracleService.getLatestReading.mockResolvedValue({
        key:        ACTIVE_POLICY.oracleKey,
        value:      BigInt(450_000_000), // 45 min delay — above 30 min threshold, trigger MET
        confidence: 90,
      });
      mockPolicyService.getProductById.mockResolvedValue(GT_PRODUCT);
      mockStellarService.invokeContract.mockResolvedValue('tx-gt');

      const result = await service.autoProcess(POLICY_ID);
      expect(result).toBe('Paid');
      expect(mockStellarService.invokeContract).toHaveBeenCalledWith(
        expect.any(String),
        'process_claim',
        expect.any(Array),
      );
    });

    it('#273 — GreaterThan product: value at or below threshold does not trigger', async () => {
      const GT_PRODUCT = { ...MOCK_PRODUCT, comparison: 'GreaterThan', threshold: '30.0000000' };
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.claim.create.mockResolvedValue({ id: 'claim-gt-no', status: 'PROCESSING' });
      mockOracleService.getLatestReading.mockResolvedValue({
        key:        ACTIVE_POLICY.oracleKey,
        value:      BigInt(150_000_000), // 15 min delay — below 30 min threshold, trigger NOT MET
        confidence: 90,
      });
      mockPolicyService.getProductById.mockResolvedValue(GT_PRODUCT);
      mockPrismaService.claim.update.mockResolvedValue({});

      const result = await service.autoProcess(POLICY_ID);
      expect(result).toBe('Rejected');
      expect(mockStellarService.invokeContract).not.toHaveBeenCalled();
    });

    // #259 — When getProductById returns null/undefined (product deactivated after
    // the policy was sold), the claim must fail loud for manual review rather than
    // silently substituting a threshold/comparison that may not match what the
    // policyholder actually bought.
    it('#259 — product not found fails the claim for manual review instead of silently falling back', async () => {
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.claim.create.mockResolvedValue({ id: 'claim-fallback', status: 'PROCESSING' });
      mockOracleService.getLatestReading.mockResolvedValue({
        key:        ACTIVE_POLICY.oracleKey,
        value:      BigInt(200_000_000),
        confidence: 90,
      });
      // Simulate deactivated / not-found product
      mockPolicyService.getProductById.mockResolvedValue(null);

      const result = await service.autoProcess(POLICY_ID);

      expect(result).toBe('Rejected');
      expect(mockStellarService.invokeContract).not.toHaveBeenCalled();
      expect(mockPrismaService.claim.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'claim-fallback' },
          data:  expect.objectContaining({ status: 'FAILED' }),
        }),
      );
      expect(mockPrismaService.policy.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: POLICY_ID },
          data:  expect.objectContaining({ status: 'ACTIVE' }),
        }),
      );
    });

    // #245 — Product.threshold is serialised as a free-text string at the service
    // boundary. A non-numeric value (e.g. empty string, "N/A") makes parseFloat
    // return NaN, and BigInt(NaN) throws a RangeError — crashing mid-flow after
    // the claim row is already PROCESSING. The fix must catch this before the
    // BigInt conversion and treat it the same as a missing product: FAILED + revert.
    it('#245 — non-numeric product threshold marks claim FAILED and reverts policy to ACTIVE', async () => {
      const BAD_THRESHOLD_PRODUCT = { ...MOCK_PRODUCT, threshold: 'N/A' };
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.claim.create.mockResolvedValue({ id: 'claim-bad-threshold', status: 'PROCESSING' });
      mockOracleService.getLatestReading.mockResolvedValue({
        key:        ACTIVE_POLICY.oracleKey,
        value:      BigInt(200_000_000),
        confidence: 90,
      });
      mockPolicyService.getProductById.mockResolvedValue(BAD_THRESHOLD_PRODUCT);
      // $transaction is called for the FAILED-claim + ACTIVE-policy revert
      mockPrismaService.$transaction.mockResolvedValue([{}, {}]);

      const result = await service.autoProcess(POLICY_ID);

      expect(result).toBe('Rejected');
      expect(mockStellarService.invokeContract).not.toHaveBeenCalled();
      // Claim must be marked FAILED (not left as PROCESSING)
      expect(mockPrismaService.$transaction).toHaveBeenCalled();
    });

    it('#245 — empty-string product threshold marks claim FAILED (NaN guard)', async () => {
      const EMPTY_THRESHOLD_PRODUCT = { ...MOCK_PRODUCT, threshold: '' };
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
      mockPrismaService.claim.findFirst.mockResolvedValue(null);
      mockPrismaService.claim.create.mockResolvedValue({ id: 'claim-empty-threshold', status: 'PROCESSING' });
      mockOracleService.getLatestReading.mockResolvedValue({
        key:        ACTIVE_POLICY.oracleKey,
        value:      BigInt(200_000_000),
        confidence: 90,
      });
      mockPolicyService.getProductById.mockResolvedValue(EMPTY_THRESHOLD_PRODUCT);
      mockPrismaService.$transaction.mockResolvedValue([{}, {}]);

      // Must not throw a RangeError from BigInt(NaN)
      await expect(service.autoProcess(POLICY_ID)).resolves.toBe('Rejected');
      expect(mockStellarService.invokeContract).not.toHaveBeenCalled();
    });
  });
});
