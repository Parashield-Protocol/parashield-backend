import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaimsService } from './claims.service';
import { StellarService } from '../stellar/stellar.service';
import { OracleService } from '../oracle/oracle.service';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';

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
    },
    claim: {
      findFirst:  jest.fn(),
      findMany:   jest.fn(),
      findUnique: jest.fn(),
      create:     jest.fn(),
      update:     jest.fn(),
    },
  };

  const POLICY_ID = 'test-policy-uuid';
  const CLAIMANT  = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';

  const ACTIVE_POLICY = {
    id:           POLICY_ID,
    productId:    '1',
    policyholder: CLAIMANT,
    coverageXlm:  100,
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

    it('should create a PROCESSING claim record for an ACTIVE policy', async () => {
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
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
      mockPrismaService.claim.create.mockResolvedValue({ id: 'claim-1', status: 'PROCESSING' });
      mockOracleService.getLatestReading.mockResolvedValue(null);
      mockPrismaService.claim.update.mockResolvedValue({});

      const result = await service.autoProcess(POLICY_ID);
      expect(result).toBe('Rejected');
    });

    it('should return Rejected when oracle value is above the LessThan threshold', async () => {
      mockPrismaService.policy.findUnique.mockResolvedValue(ACTIVE_POLICY);
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
      mockPrismaService.claim.create.mockResolvedValue({ id: 'claim-1', status: 'PROCESSING' });
      mockOracleService.getLatestReading.mockResolvedValue({
        key:        ACTIVE_POLICY.oracleKey,
        value:      BigInt(200_000_000), // 20 mm — below 50 mm threshold, trigger MET
        confidence: 90,
      });
      mockPolicyService.getProductById.mockResolvedValue(MOCK_PRODUCT);
      mockStellarService.invokeContract.mockResolvedValue('tx-hash-abc');
      mockPrismaService.claim.update.mockResolvedValue({});
      mockPrismaService.policy.update.mockResolvedValue({});

      const result = await service.autoProcess(POLICY_ID);
      expect(result).toBe('Paid');
      expect(mockStellarService.invokeContract).toHaveBeenCalledWith(
        expect.any(String),
        'process_claim',
        expect.any(Array),
      );
    });
  });
});
