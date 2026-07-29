import { validate } from 'class-validator';
import { OracleFeedRequestDto } from './oracle-reading.dto';

describe('OracleFeedRequestDto', () => {
  function validDto(): OracleFeedRequestDto {
    const dto = new OracleFeedRequestDto();
    dto.lat = -0.0917;
    dto.lng = 34.7679;
    dto.year = 2026;
    dto.month = 6;
    return dto;
  }

  it('passes validation with a fully valid DTO', async () => {
    const errors = await validate(validDto());
    expect(errors).toHaveLength(0);
  });

  describe('lat', () => {
    it('fails when not a number', async () => {
      const dto = validDto();
      dto.lat = 'invalid' as any;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('lat');
    });

    it('fails when below -90', async () => {
      const dto = validDto();
      dto.lat = -91;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('lat');
    });

    it('fails when above 90', async () => {
      const dto = validDto();
      dto.lat = 91;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('lat');
    });

    it('fails when missing', async () => {
      const dto = validDto();
      delete (dto as any).lat;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('lat');
    });

    it('passes at boundary of -90', async () => {
      const dto = validDto();
      dto.lat = -90;
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('passes at boundary of 90', async () => {
      const dto = validDto();
      dto.lat = 90;
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });

  describe('lng', () => {
    it('fails when not a number', async () => {
      const dto = validDto();
      dto.lng = 'invalid' as any;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('lng');
    });

    it('fails when below -180', async () => {
      const dto = validDto();
      dto.lng = -181;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('lng');
    });

    it('fails when above 180', async () => {
      const dto = validDto();
      dto.lng = 181;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('lng');
    });

    it('fails when missing', async () => {
      const dto = validDto();
      delete (dto as any).lng;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('lng');
    });

    it('passes at boundary of -180', async () => {
      const dto = validDto();
      dto.lng = -180;
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('passes at boundary of 180', async () => {
      const dto = validDto();
      dto.lng = 180;
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });

  describe('year', () => {
    it('fails when not an integer (float)', async () => {
      const dto = validDto();
      dto.year = 2026.5;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('year');
    });

    it('fails when below 2000', async () => {
      const dto = validDto();
      dto.year = 1999;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('year');
    });

    it('fails when above 2100', async () => {
      const dto = validDto();
      dto.year = 2101;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('year');
    });

    it('fails when missing', async () => {
      const dto = validDto();
      delete (dto as any).year;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('year');
    });

    it('passes at boundary of 2000', async () => {
      const dto = validDto();
      dto.year = 2000;
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('passes at boundary of 2100', async () => {
      const dto = validDto();
      dto.year = 2100;
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });

  describe('month', () => {
    it('fails when not an integer', async () => {
      const dto = validDto();
      dto.month = 6.5;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('month');
    });

    it('fails when below 1', async () => {
      const dto = validDto();
      dto.month = 0;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('month');
    });

    it('fails when above 12', async () => {
      const dto = validDto();
      dto.month = 13;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('month');
    });

    it('fails when missing', async () => {
      const dto = validDto();
      delete (dto as any).month;
      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('month');
    });

    it('passes at boundary of 1', async () => {
      const dto = validDto();
      dto.month = 1;
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('passes at boundary of 12', async () => {
      const dto = validDto();
      dto.month = 12;
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });
});
