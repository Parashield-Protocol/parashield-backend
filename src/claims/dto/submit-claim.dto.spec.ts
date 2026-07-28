import { validate } from 'class-validator';
import { SubmitClaimDto } from './submit-claim.dto';

describe('SubmitClaimDto', () => {
  function validDto(): SubmitClaimDto {
    const dto = new SubmitClaimDto();
    dto.claimant = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
    dto.policyId = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
    return dto;
  }

  it('passes validation with a fully valid DTO', async () => {
    const errors = await validate(validDto());
    expect(errors).toHaveLength(0);
  });

  describe('claimant', () => {
    it('fails when not a string', async () => {
      const dto = validDto();
      dto.claimant = 123 as any;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('claimant');
    });

    it('fails when invalid format (does not start with G)', async () => {
      const dto = validDto();
      dto.claimant = 'AAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('claimant');
    });

    it('fails when length is not 56 characters', async () => {
      const dto = validDto();
      dto.claimant = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQ'; // 55 chars
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('claimant');
    });

    it('fails when contains invalid characters', async () => {
      const dto = validDto();
      dto.claimant = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQ0'; // has 0 (invalid in base32)
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('claimant');
    });

    it('fails when missing', async () => {
      const dto = validDto();
      delete (dto as any).claimant;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('claimant');
    });
  });

  describe('policyId', () => {
    it('fails when not a valid UUID', async () => {
      const dto = validDto();
      dto.policyId = 'invalid-uuid';
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('policyId');
    });

    it('fails when missing', async () => {
      const dto = validDto();
      delete (dto as any).policyId;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('policyId');
    });
  });
});
