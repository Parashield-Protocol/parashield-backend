import { validate } from 'class-validator';
import { ConfirmPolicyDto } from './confirm-policy.dto';

describe('ConfirmPolicyDto', () => {
  function validDto(): ConfirmPolicyDto {
    const dto = new ConfirmPolicyDto();
    dto.signedXdr = 'AAAAAgAAAAA...';
    dto.productId = '1';
    dto.coverageXlm = 500;
    dto.walletAddress = 'GMRFVCGKW6CSIEQIIIFFDKPQUXVBRNDFYKIPIOBAQPYXAL5QEGX2652T';
    dto.duration = 90;
    dto.oracleKey = 'rainfall:-0.0917,34.7679:2026-06';
    return dto;
  }

  it('passes validation with a fully valid DTO', async () => {
    const errors = await validate(validDto());
    expect(errors).toHaveLength(0);
  });

  describe('signedXdr', () => {
    it('fails when empty', async () => {
      const dto = validDto();
      dto.signedXdr = '';
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('signedXdr');
    });

    it('fails when missing', async () => {
      const dto = validDto();
      delete (dto as any).signedXdr;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('signedXdr');
    });
  });

  describe('productId', () => {
    it('fails when empty', async () => {
      const dto = validDto();
      dto.productId = '';
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('productId');
    });
  });

  describe('coverageXlm', () => {
    it('fails when below minimum of 10', async () => {
      const dto = validDto();
      dto.coverageXlm = 5;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('coverageXlm');
    });

    it('fails when above maximum of 100000', async () => {
      const dto = validDto();
      dto.coverageXlm = 200000;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('coverageXlm');
    });

    it('fails when zero', async () => {
      const dto = validDto();
      dto.coverageXlm = 0;
      const errors = await validate(dto);
      expect(errors[0].property).toBe('coverageXlm');
    });

    it('fails when negative', async () => {
      const dto = validDto();
      dto.coverageXlm = -100;
      const errors = await validate(dto);
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
  });

  describe('walletAddress', () => {
    it('fails with an invalid Stellar address format', async () => {
      const dto = validDto();
      dto.walletAddress = 'invalid';
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('walletAddress');
    });

    it('fails with an empty string', async () => {
      const dto = validDto();
      dto.walletAddress = '';
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('walletAddress');
    });
  });

  describe('duration', () => {
    it('fails when below 1 day', async () => {
      const dto = validDto();
      dto.duration = 0;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('duration');
    });

    it('fails when above 365 days', async () => {
      const dto = validDto();
      dto.duration = 400;
      const errors = await validate(dto);
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

    it('accepts a valid defi key', async () => {
      const dto = validDto();
      dto.oracleKey = 'defi:eth_price:2026-06';
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('rejects an unknown category prefix', async () => {
      const dto = validDto();
      dto.oracleKey = 'unknown:value';
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('oracleKey');
    });

    it('fails when empty', async () => {
      const dto = validDto();
      dto.oracleKey = '';
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('oracleKey');
    });
  });
});
