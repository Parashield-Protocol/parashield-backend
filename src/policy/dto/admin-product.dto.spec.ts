import { validate } from 'class-validator';
import { CreateProductDto } from './admin-product.dto';

describe('CreateProductDto', () => {
  function validDto(): CreateProductDto {
    const dto = new CreateProductDto();
    dto.name = 'Kisumu Rainfall Cover';
    dto.category = 'crop';
    dto.triggerType = 'Threshold';
    dto.threshold = 50;
    dto.comparison = 'gte';
    dto.coverageMin = 10;
    dto.coverageMax = 1000;
    dto.premiumRate = 500;
    dto.maxDuration = 365;
    return dto;
  }

  it('passes validation with a fully valid DTO', async () => {
    const errors = await validate(validDto());
    expect(errors).toHaveLength(0);
  });

  describe('maxDuration', () => {
    it('fails when 0', async () => {
      const dto = validDto();
      dto.maxDuration = 0;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('maxDuration');
    });

    it('fails when above 365', async () => {
      const dto = validDto();
      dto.maxDuration = 366;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('maxDuration');
    });

    it('fails when not an integer', async () => {
      const dto = validDto();
      dto.maxDuration = 10.5;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('maxDuration');
    });

    it('passes at the upper bound of 365', async () => {
      const dto = validDto();
      dto.maxDuration = 365;
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });
});
