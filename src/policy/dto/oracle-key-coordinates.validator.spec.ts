import { validate } from 'class-validator';
import { BuyPolicyDto } from './buy-policy.dto';

function makeDto(oracleKey: string): BuyPolicyDto {
  const dto = new BuyPolicyDto();
  dto.productId = '1';
  dto.coverageXlm = 500;
  dto.walletAddress = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZA';
  dto.duration = 90;
  dto.oracleKey = oracleKey;
  return dto;
}

describe('IsValidOracleKeyCoordinates', () => {
  it('accepts an in-range rainfall coordinate pair', async () => {
    const errors = await validate(makeDto('rainfall:-0.0917,34.7679:2026-06'));
    expect(errors).toHaveLength(0);
  });

  it('rejects an out-of-range latitude', async () => {
    const errors = await validate(makeDto('rainfall:9999,34.7679:2026-06'));
    expect(errors.some((e) => e.property === 'oracleKey')).toBe(true);
  });

  it('rejects an out-of-range longitude', async () => {
    const errors = await validate(makeDto('rainfall:-0.0917,9999:2026-06'));
    expect(errors.some((e) => e.property === 'oracleKey')).toBe(true);
  });

  it('does not affect non-rainfall keys', async () => {
    const errors = await validate(makeDto('flight:BA123:2026-06-15'));
    expect(errors).toHaveLength(0);
  });
});
