import { validatePortEnv } from './config.utils';

describe('validatePortEnv', () => {
  it.each([1, 3001, 65_535, '8080'] as const)('accepts valid port %p', (value) => {
    expect(validatePortEnv(value)).toBe(Number(value));
  });

  it('uses the documented default when unset', () => {
    expect(validatePortEnv(undefined)).toBe(3001);
  });

  it.each([0, -1, 65_536, '1.5', 'abc', '3000junk', Number.NaN, Number.POSITIVE_INFINITY])(
    'fails fast for invalid port %p',
    (value) => {
      expect(() => validatePortEnv(value)).toThrow('PORT must be an integer between 1 and 65535');
    },
  );
});
