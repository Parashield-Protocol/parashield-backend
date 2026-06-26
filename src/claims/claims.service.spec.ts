import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { ClaimsService } from './claims.service';
import { StellarService } from '../stellar/stellar.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ClaimsService', () => {
  let service: ClaimsService;

  const mockStellarService = {
    invokeContract: jest.fn(),
  };

  const mockPrismaService = {
    policy: {
      findUnique: jest.fn(),
    },
    claim: {
      findFirst:  jest.fn(),
      findMany:   jest.fn(),
      findUnique: jest.fn(),
      create:     jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaimsService,
        { provide: StellarService, useValue: mockStellarService },
        { provide: PrismaService,  useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<ClaimsService>(ClaimsService);
    jest.clearAllMocks();
  });

  describe('submitClaim — duplicate claim prevention', () => {
    const POLICY_ID  = 'test-policy-uuid';
    const CLAIMANT   = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';

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
      mockPrismaService.policy.findUnique.mockResolvedValue({
        id:           'p1',
        policyholder: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ',
        coverageXlm:  100,
        status:       'ACTIVE',
      });
      mockPrismaService.claim.create.mockResolvedValue({ id: 'claim-1', status: 'PROCESSING' });

      await service.autoProcess('p1');

      expect(mockPrismaService.claim.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            policyId: 'p1',
            status:   'PROCESSING',
          }),
        }),
      );
    });
  });
});
