import { validate } from 'class-validator';
import { ProductResponseDto, PolicyResponseDto } from './policy-response.dto';

describe('policy-response.dto', () => {
  describe('ProductResponseDto', () => {
    function createValidProduct(): ProductResponseDto {
      const dto = new ProductResponseDto();
      dto.id = 'prod-123';
      dto.name = 'Crop Insurance';
      dto.category = 'crop';
      dto.triggerType = 'Threshold';
      dto.threshold = '10000000';
      dto.premiumRate = 500;
      dto.maxDuration = 90;
      dto.status = 'Active';
      return dto;
    }

    it('can be instantiated and shaped correctly', () => {
      const dto = createValidProduct();
      expect(dto.id).toBe('prod-123');
      expect(dto.name).toBe('Crop Insurance');
      expect(dto.category).toBe('crop');
      expect(dto.triggerType).toBe('Threshold');
      expect(dto.threshold).toBe('10000000');
      expect(dto.premiumRate).toBe(500);
      expect(dto.maxDuration).toBe(90);
      expect(dto.status).toBe('Active');

      expect(typeof dto.id).toBe('string');
      expect(typeof dto.name).toBe('string');
      expect(typeof dto.category).toBe('string');
      expect(typeof dto.triggerType).toBe('string');
      expect(typeof dto.threshold).toBe('string');
      expect(typeof dto.premiumRate).toBe('number');
      expect(typeof dto.maxDuration).toBe('number');
      expect(typeof dto.status).toBe('string');
    });

    it('passes validation checks as it has no active input decorators', async () => {
      const dto = createValidProduct();
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });

  describe('PolicyResponseDto', () => {
    function createValidPolicy(): PolicyResponseDto {
      const dto = new PolicyResponseDto();
      dto.id = 'policy-abc-123';
      dto.productId = 'prod-123';
      dto.policyholder = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
      dto.coverageXlm = '15000000000';
      dto.premiumPaid = '750000000';
      dto.oracleKey = 'rainfall:-0.0917,34.7679:2026-06';
      dto.startTime = Math.floor(Date.now() / 1000);
      dto.endTime = Math.floor(Date.now() / 1000) + 90 * 86400;
      dto.status = 'ACTIVE';
      dto.txHash = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
      return dto;
    }

    it('can be instantiated and shaped correctly', () => {
      const dto = createValidPolicy();
      expect(dto.id).toBe('policy-abc-123');
      expect(dto.productId).toBe('prod-123');
      expect(dto.policyholder).toBe('GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ');
      expect(dto.coverageXlm).toBe('15000000000');
      expect(dto.premiumPaid).toBe('750000000');
      expect(dto.oracleKey).toBe('rainfall:-0.0917,34.7679:2026-06');
      expect(typeof dto.startTime).toBe('number');
      expect(typeof dto.endTime).toBe('number');
      expect(dto.status).toBe('ACTIVE');
      expect(dto.txHash).toBe('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');

      expect(typeof dto.id).toBe('string');
      expect(typeof dto.productId).toBe('string');
      expect(typeof dto.policyholder).toBe('string');
      expect(typeof dto.coverageXlm).toBe('string');
      expect(typeof dto.premiumPaid).toBe('string');
      expect(typeof dto.oracleKey).toBe('string');
      expect(typeof dto.status).toBe('string');
      expect(typeof dto.txHash).toBe('string');
    });

    it('accepts null for txHash', () => {
      const dto = createValidPolicy();
      dto.txHash = null;
      expect(dto.txHash).toBeNull();
    });

    it('passes validation checks as it has no active input decorators', async () => {
      const dto = createValidPolicy();
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });
});
