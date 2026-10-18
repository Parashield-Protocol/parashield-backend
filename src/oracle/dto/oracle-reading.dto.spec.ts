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

  describe('NaN and Infinity rejection (#752)', () => {
    it('rejects NaN for lat with a clear error message', async () => {
      const dto = validDto();
      dto.lat = NaN;
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      const latError = errors.find((e) => e.property === 'lat');
      expect(latError).toBeDefined();
      expect(latError!.constraints).toBeDefined();
      expect(
        Object.values(latError!.constraints!).some((msg) =>
          msg.includes('finite number') || msg.includes('NaN'),
        ),
      ).toBe(true);
    });

    it('rejects Infinity and -Infinity for lat', async () => {
      const dtoPos = validDto();
      dtoPos.lat = Infinity;
      const errorsPos = await validate(dtoPos);
      expect(errorsPos.some((e) => e.property === 'lat')).toBe(true);

      const dtoNeg = validDto();
      dtoNeg.lat = -Infinity;
      const errorsNeg = await validate(dtoNeg);
      expect(errorsNeg.some((e) => e.property === 'lat')).toBe(true);
    });

    it('rejects NaN for lng with a clear error message', async () => {
      const dto = validDto();
      dto.lng = NaN;
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      const lngError = errors.find((e) => e.property === 'lng');
      expect(lngError).toBeDefined();
      expect(lngError!.constraints).toBeDefined();
      expect(
        Object.values(lngError!.constraints!).some((msg) =>
          msg.includes('finite number') || msg.includes('NaN'),
        ),
      ).toBe(true);
    });

    it('rejects Infinity and -Infinity for lng', async () => {
      const dtoPos = validDto();
      dtoPos.lng = Infinity;
      const errorsPos = await validate(dtoPos);
      expect(errorsPos.some((e) => e.property === 'lng')).toBe(true);

      const dtoNeg = validDto();
      dtoNeg.lng = -Infinity;
      const errorsNeg = await validate(dtoNeg);
      expect(errorsNeg.some((e) => e.property === 'lng')).toBe(true);
    });
  });
});

describe('OracleReadingDto (#752)', () => {
  const { OracleReadingDto } = require('./oracle-reading.dto');

  function validReadingDto(): InstanceType<typeof OracleReadingDto> {
    const dto = new OracleReadingDto();
    dto.dataType = 'weather';
    dto.key = 'rainfall:-0.0917,34.7679:2026-06';
    dto.value = 32.4;
    dto.confidence = 95;
    dto.timestamp = 1719576600;
    dto.source = 'open-meteo';
    return dto;
  }

  it('passes validation with finite numeric value and confidence', async () => {
    const dto = validReadingDto();
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects NaN for value with clear validation error', async () => {
    const dto = validReadingDto();
    dto.value = NaN;
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const valueError = errors.find((e) => e.property === 'value');
    expect(valueError).toBeDefined();
    expect(
      Object.values(valueError!.constraints!).some((msg) =>
        msg.includes('finite number') || msg.includes('NaN'),
      ),
    ).toBe(true);
  });

  it('rejects Infinity and -Infinity for value', async () => {
    const dtoPos = validReadingDto();
    dtoPos.value = Infinity;
    const errorsPos = await validate(dtoPos);
    expect(errorsPos.some((e) => e.property === 'value')).toBe(true);

    const dtoNeg = validReadingDto();
    dtoNeg.value = -Infinity;
    const errorsNeg = await validate(dtoNeg);
    expect(errorsNeg.some((e) => e.property === 'value')).toBe(true);
  });

  it('rejects NaN for confidence', async () => {
    const dto = validReadingDto();
    dto.confidence = NaN;
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'confidence')).toBe(true);
  });

  it('rejects Infinity for confidence', async () => {
    const dto = validReadingDto();
    dto.confidence = Infinity;
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'confidence')).toBe(true);
  });
});

