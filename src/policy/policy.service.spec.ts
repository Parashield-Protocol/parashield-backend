import { Test, TestingModule } from '@nestjs/testing';
import { PolicyService, ProductSummary } from './policy.service';
import { StellarService } from '../stellar/stellar.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PolicyService.calculatePremium', () => {
  let service: PolicyService;

  const mockStellarService = {
    simulateInvoke: jest.fn(),
    keeperKeypair:  { publicKey: jest.fn().mockReturnValue('GABC') },
  };

  const mockPrismaService = {
    policy: {
      create:     jest.fn(),
      findMany:   jest.fn(),
      findUnique: jest.fn(),
      count:      jest.fn(),
    },
    product: {
      findMany:   jest.fn(),
      findUnique: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PolicyService,
        { provide: StellarService, useValue: mockStellarService },
        { provide: PrismaService,  useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<PolicyService>(PolicyService);
    jest.clearAllMocks();
  });

  it('should return the correct premium for standard coverage', () => {
    // coverage=1000, rate=500 (5%)
    // expected = Math.ceil(1000 * 500 / 10000) = Math.ceil(50) = 50
    const premium = service.calculatePremium(1000, 500);
    expect(premium).toBe(50);
  });

  it('should return the same premium regardless of duration', () => {
    const premium1 = service.calculatePremium(1000, 500);
    const premium2 = service.calculatePremium(1000, 500);
    expect(premium1).toBe(premium2);
  });

  it('should always return a positive integer', () => {
    const testCases = [
      [10, 100],
      [500, 200],
      [100000, 500],
      [10, 500],
    ] as const;

    for (const [coverage, rate] of testCases) {
      const premium = service.calculatePremium(coverage, rate);
      expect(premium).toBeGreaterThan(0);
      expect(Number.isInteger(premium)).toBe(true);
    }
  });

  describe('validateCoverage', () => {
    const product: ProductSummary = {
      id:          '1',
      name:        'Test Product',
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

    it('should return valid for coverage within range', () => {
      const result = service.validateCoverage(500, product);
      expect(result.valid).toBe(true);
    });

    it('should return invalid for coverage below minimum', () => {
      const result = service.validateCoverage(5, product);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('below the minimum');
    });

    it('should return invalid for coverage above maximum', () => {
      const result = service.validateCoverage(5000, product);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('exceeds the maximum');
    });
  });

  describe('getActiveProducts', () => {
    it('should fetch active products from the database', async () => {
      mockPrismaService.product.findMany.mockResolvedValue([
        {
          id:          '1',
          name:        'Crop Product',
          category:    'crop',
          triggerType: 'Threshold',
          threshold:   '50.0',
          comparison:  'LessThan',
          coverageMin: '10.0',
          coverageMax: '1000.0',
          premiumRate: 500,
          maxDuration: 365,
          status:      'Active',
        },
      ]);

      const products = await service.getActiveProducts();
      expect(products).toHaveLength(1);
      expect(products[0].name).toBe('Crop Product');
      expect(mockPrismaService.product.findMany).toHaveBeenCalledWith({
        where: { status: 'Active' },
      });
    });
  });

  describe('createPolicy', () => {
    const validCropProduct = {
      id:          '1',
      name:        'Crop Product',
      category:    'crop',
      triggerType: 'Threshold',
      threshold:   '50.0',
      comparison:  'LessThan',
      coverageMin: '10.0',
      coverageMax: '1000.0',
      premiumRate: 500,
      maxDuration: 365,
      status:      'Active',
    };

    it('should successfully create policy with a valid crop oracleKey', async () => {
      mockPrismaService.product.findMany.mockResolvedValue([validCropProduct]);
      mockPrismaService.policy.create.mockResolvedValue({ id: 'policy-1' });

      const dto = {
        productId: '1',
        coverageXlm: 500,
        walletAddress: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ',
        duration: 90,
        oracleKey: 'rainfall:-0.0917,34.7679:2026-06',
      };

      const policy = await service.createPolicy(dto, 'tx-hash-123');
      expect(policy.id).toBe('policy-1');
      expect(mockPrismaService.policy.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: '1',
            oracleKey: 'rainfall:-0.0917,34.7679:2026-06',
          }),
        }),
      );
    });

    it('should throw BadRequestException if product does not exist', async () => {
      mockPrismaService.product.findMany.mockResolvedValue([]);

      const dto = {
        productId: 'nonexistent',
        coverageXlm: 500,
        walletAddress: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ',
        duration: 90,
        oracleKey: 'rainfall:-0.0917,34.7679:2026-06',
      };

      await expect(service.createPolicy(dto, 'tx-hash')).rejects.toThrow(
        /Product with ID nonexistent not found or inactive/,
      );
    });

    it('should throw BadRequestException for invalid crop oracleKey format', async () => {
      mockPrismaService.product.findMany.mockResolvedValue([validCropProduct]);

      const dto = {
        productId: '1',
        coverageXlm: 500,
        walletAddress: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ',
        duration: 90,
        oracleKey: 'invalid-crop-key',
      };

      await expect(service.createPolicy(dto, 'tx-hash')).rejects.toThrow(
        /oracleKey format must be rainfall:lat,lng:YYYY-MM for crop products/,
      );
    });
  });

  describe('getUserPolicies pagination (Issue #72)', () => {
    const wallet = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';

    const makeDbPolicy = (id: string) => ({
      id,
      productId:    'prod-1',
      policyholder: wallet,
      coverageXlm:  500,
      premiumPaid:  25,
      oracleKey:    'rainfall:0,0:2026-06',
      startTime:    new Date('2026-01-01'),
      endTime:      new Date('2026-04-01'),
      status:       'ACTIVE',
      txHash:       `tx-${id}`,
      createdAt:    new Date('2026-01-01'),
    });

    it('returns paginated data with total, page, and limit', async () => {
      const dbPolicies = [makeDbPolicy('p1'), makeDbPolicy('p2')];
      mockPrismaService.policy.findMany.mockResolvedValue(dbPolicies);
      mockPrismaService.policy.count.mockResolvedValue(10);

      const result = await service.getUserPolicies(wallet, 1, 2);

      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(10);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(2);
    });

    it('calls prisma with correct take and skip for page 2', async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([]);
      mockPrismaService.policy.count.mockResolvedValue(0);

      await service.getUserPolicies(wallet, 2, 5);

      expect(mockPrismaService.policy.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5, skip: 5 }),
      );
    });

    it('clamps limit to 100 maximum', async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([]);
      mockPrismaService.policy.count.mockResolvedValue(0);

      const result = await service.getUserPolicies(wallet, 1, 999);

      expect(result.limit).toBe(100);
      expect(mockPrismaService.policy.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });

    it('defaults to page=1 and limit=20 when not provided', async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([]);
      mockPrismaService.policy.count.mockResolvedValue(0);

      const result = await service.getUserPolicies(wallet);

      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(mockPrismaService.policy.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20, skip: 0 }),
      );
    });

    it('maps database rows to PolicySummary shape', async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([makeDbPolicy('p1')]);
      mockPrismaService.policy.count.mockResolvedValue(1);

      const result = await service.getUserPolicies(wallet, 1, 20);
      const p = result.data[0];

      expect(p.id).toBe('p1');
      expect(p.coverage).toBe('500');
      expect(p.premiumPaid).toBe('25');
      expect(typeof p.startTime).toBe('number');
      expect(typeof p.endTime).toBe('number');
    });
  });
});
