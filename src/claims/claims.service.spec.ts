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
  };

  const mockConfigService = {
    get: jest.fn().mockReturnValue(''),
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
      mockPolicyService.getActiveProducts.mockResolvedValue([MOCK_PRODUCT]);
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
      mockPolicyService.getActiveProducts.mockResolvedValue([MOCK_PRODUCT]);
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
