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
    // coverage=1000, rate=500 (5%), duration=365 days
    // expected = Math.ceil(1000 * 500 * (365/365) / 10000) = Math.ceil(50) = 50
    const premium = service.calculatePremium(1000, 500, 365);
    expect(premium).toBe(50);
  });

  it('should return a proportionally higher premium for shorter duration', () => {
    // 182 days is ~half a year, so premium should be roughly half
    const fullYearPremium = service.calculatePremium(1000, 500, 365);
    const halfYearPremium = service.calculatePremium(1000, 500, 182);

    expect(halfYearPremium).toBeLessThan(fullYearPremium);
    // Half-year should be approximately half the full year (within 2 XLM tolerance)
    expect(halfYearPremium).toBeGreaterThan(fullYearPremium / 2 - 2);
    expect(halfYearPremium).toBeLessThan(fullYearPremium / 2 + 2);
  });

  it('should always return a positive integer', () => {
    const testCases = [
      [10, 100, 1],
      [500, 200, 30],
      [100000, 500, 365],
      [10, 500, 1],
    ] as const;

    for (const [coverage, rate, duration] of testCases) {
      const premium = service.calculatePremium(coverage, rate, duration);
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
});
