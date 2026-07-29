import { validate } from 'class-validator';
import { BuyPolicyDto } from './buy-policy.dto';

describe('BuyPolicyDto', () => {
  function validDto(): BuyPolicyDto {
    const dto = new BuyPolicyDto();
    dto.productId = '1';
    dto.coverageXlm = 500;
    dto.walletAddress = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
    dto.duration = 90;
    dto.oracleKey = 'rainfall:-0.0917,34.7679:2026-06';
    return dto;
  }

  it('passes validation with a fully valid DTO', async () => {
    const errors = await validate(validDto());
    expect(errors).toHaveLength(0);
  });

  describe('productId', () => {
    it('fails when empty', async () => {
      const dto = validDto();
      dto.productId = '';
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('productId');
    });

    it('fails when missing', async () => {
      const dto = validDto();
      delete (dto as any).productId;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('productId');
    });

    it('fails when type is not string', async () => {
      const dto = validDto();
      dto.productId = 123 as any;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('productId');
    });
  });

  describe('coverageXlm', () => {
    it('fails when below minimum of 10', async () => {
      const dto = validDto();
      dto.coverageXlm = 9;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('coverageXlm');
    });

    it('fails when above maximum of 100000', async () => {
      const dto = validDto();
      dto.coverageXlm = 100001;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('coverageXlm');
    });

    it('fails when zero', async () => {
      const dto = validDto();
      dto.coverageXlm = 0;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('coverageXlm');
    });

    it('fails when negative', async () => {
      const dto = validDto();
      dto.coverageXlm = -10;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('coverageXlm');
    });

    it('fails when missing', async () => {
      const dto = validDto();
      delete (dto as any).coverageXlm;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('coverageXlm');
    });

    it('fails when not a number', async () => {
      const dto = validDto();
      dto.coverageXlm = 'string' as any;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('coverageXlm');
    });

    it('fails when decimal places exceed 7', async () => {
      const dto = validDto();
      dto.coverageXlm = 10.12345678;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('coverageXlm');
    });

    it('passes at boundary value of 10', async () => {
      const dto = validDto();
      dto.coverageXlm = 10;
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('passes at boundary value of 100000', async () => {
      const dto = validDto();
      dto.coverageXlm = 100000;
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('passes with up to 7 decimal places', async () => {
      const dto = validDto();
      dto.coverageXlm = 10.1234567;
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });

  describe('walletAddress', () => {
    it('fails when invalid format (does not start with G)', async () => {
      const dto = validDto();
      dto.walletAddress = 'AAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('walletAddress');
    });

    it('fails when length is not 56 characters', async () => {
      const dto = validDto();
      dto.walletAddress = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQ'; // 55 chars
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('walletAddress');
    });

    it('fails when contains invalid characters', async () => {
      const dto = validDto();
      dto.walletAddress = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQ0'; // has 0 (invalid in base32)
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('walletAddress');
    });

    it('fails when missing', async () => {
      const dto = validDto();
      delete (dto as any).walletAddress;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('walletAddress');
    });
  });

  describe('duration', () => {
    it('fails when below 1', async () => {
      const dto = validDto();
      dto.duration = 0;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('duration');
    });

    it('fails when above 365', async () => {
      const dto = validDto();
      dto.duration = 366;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('duration');
    });

    it('fails when not an integer (float)', async () => {
      const dto = validDto();
      dto.duration = 10.5;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('duration');
    });

    it('fails when missing', async () => {
      const dto = validDto();
      delete (dto as any).duration;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('duration');
    });

    it('passes at boundary of 1 day', async () => {
      const dto = validDto();
      dto.duration = 1;
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('passes at boundary of 365 days', async () => {
      const dto = validDto();
      dto.duration = 365;
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });

  describe('oracleKey', () => {
    it('accepts a valid rainfall key', async () => {
      const dto = validDto();
      dto.oracleKey = 'rainfall:-0.0917,34.7679:2026-06';
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('accepts a valid flight key', async () => {
      const dto = validDto();
      dto.oracleKey = 'flight:BA123:2026-12-15';
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('rejects a defi key', async () => {
      const dto = validDto();
      dto.oracleKey = 'defi:eth_price:2026-06';
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('oracleKey');
    });

    it('rejects out of bounds rainfall coordinates', async () => {
      const dto = validDto();
      dto.oracleKey = 'rainfall:95.0,34.7679:2026-06';
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('oracleKey');
    });

    it('fails when missing', async () => {
      const dto = validDto();
      delete (dto as any).oracleKey;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('oracleKey');
    });
  });
});
