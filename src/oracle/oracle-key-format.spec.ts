import { isValidOracleKeyFormat } from './oracle-key-format';

describe('isValidOracleKeyFormat (#473)', () => {
  it.each([
    'rainfall:-0.0917,34.7679:2026-06',
    'rainfall:0,0:2026-12',
    'temperature:-0.0917,34.7679:2026-01',
    'flight:KQ100:2026-06-27',
    'flight:BA747:2026-01-01',
  ])('accepts a well-formed key: %s', (key) => {
    expect(isValidOracleKeyFormat(key)).toBe(true);
  });

  it.each([
    ['nonexistent-key', 'no recognized prefix'],
    ['rainfall:9999,9999:2026-06', 'lat/lng out of range'],
    ['rainfall:-91,0:2026-06', 'lat below -90'],
    ['rainfall:0,181:2026-06', 'lng above 180'],
    ['rainfall:-0.09,34.76:2026-13', 'invalid month'],
    ['flight:kq100:2026-06-27', 'lowercase flight code'],
    ['flight:KQ100:2026-13-01', 'invalid month in flight date'],
    ['defi:something:2026-06', 'unsupported category'],
    ['', 'empty string'],
  ])('rejects a malformed key: %s (%s)', (key) => {
    expect(isValidOracleKeyFormat(key)).toBe(false);
  });
});
