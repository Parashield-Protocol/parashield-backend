import {
  DEFAULT_DECIMAL_SCALE,
  InvalidDecimalError,
  compareScaledToThreshold,
  evaluateThreshold,
  parseDecimalScaled,
  parseFixedPointBigInt,
} from './decimal';

describe('decimal utils (#712)', () => {
  describe('parseDecimalScaled', () => {
    it('uses a 7-decimal default scale', () => {
      expect(DEFAULT_DECIMAL_SCALE).toBe(7);
    });

    it('parses exact 7-dp strings without float error', () => {
      expect(parseDecimalScaled('50.0000000')).toBe(500_000_000n);
      expect(parseDecimalScaled('0.0000001')).toBe(1n);
      expect(parseDecimalScaled('0.1')).toBe(1_000_000n);
      expect(parseDecimalScaled('-2.5')).toBe(-25_000_000n);
      expect(parseDecimalScaled('123456789.1234567')).toBe(1_234_567_891_234_567n);
      expect(parseDecimalScaled('1')).toBe(10_000_000n);
      expect(parseDecimalScaled('0')).toBe(0n);
    });

    it('accepts numbers, bigints and sign forms', () => {
      expect(parseDecimalScaled(50)).toBe(500_000_000n);
      expect(parseDecimalScaled(50n)).toBe(500_000_000n);
      expect(parseDecimalScaled('+5')).toBe(50_000_000n);
      expect(parseDecimalScaled('.5')).toBe(5_000_000n);
      expect(parseDecimalScaled('5.')).toBe(50_000_000n);
    });

    it('accepts decimal-like objects (e.g. Prisma.Decimal) via toString', () => {
      expect(parseDecimalScaled({ toString: () => '12.5' })).toBe(125_000_000n);
    });

    it('is exact where parseFloat(binary) is not', () => {
      // 20 significant digits: the old `parseFloat(x) * 1e7` path cannot hold this.
      const exact = parseDecimalScaled('1000000000000.0000001');
      expect(exact).toBe(10_000_000_000_000_000_001n);
    });

    it('recovers the intended value from float noise (0.1 + 0.2)', () => {
      // String(0.1 + 0.2) === '0.30000000000000004'
      expect(parseDecimalScaled(0.1 + 0.2)).toBe(3_000_000n);
    });

    it('expands scientific notation exactly', () => {
      expect(parseDecimalScaled('1e-7')).toBe(1n);
      expect(parseDecimalScaled('1.5e2')).toBe(1_500_000_000n);
      expect(parseDecimalScaled('1.5e-1')).toBe(1_500_000n);
      expect(parseDecimalScaled(1e21)).toBe(10n ** 28n);
    });

    it('rounds digits beyond the scale half away from zero', () => {
      // 0.00000005 -> 0.0000001
      expect(parseDecimalScaled('0.00000005')).toBe(1n);
      // 1.23456789 -> 1.2345679
      expect(parseDecimalScaled('1.23456789')).toBe(12_345_679n);
      // -1.23456785 -> -1.2345679
      expect(parseDecimalScaled('-1.23456785')).toBe(-12_345_679n);
    });

    it('honours a custom scale', () => {
      expect(parseDecimalScaled('1.2345', 2)).toBe(123n);
      expect(parseDecimalScaled('1.235', 2)).toBe(124n);
      expect(parseDecimalScaled('10', 0)).toBe(10n);
    });

    it.each([
      ['', 'empty string'],
      ['   ', 'whitespace'],
      ['N/A', 'non-numeric text'],
      ['abc', 'letters'],
      ['1.2.3', 'multiple points'],
      ['.', 'bare point'],
      ['--5', 'double sign'],
      [null, 'null'],
      [undefined, 'undefined'],
      [NaN, 'NaN'],
      [Infinity, '-/Infinity'],
      [{}, 'object'],
    ])('throws InvalidDecimalError for %p (%s)', (value) => {
      expect(() => parseDecimalScaled(value)).toThrow(InvalidDecimalError);
    });
  });

  describe('parseFixedPointBigInt', () => {
    it('parses integer fixed-point values', () => {
      expect(parseFixedPointBigInt('200000000')).toBe(200_000_000n);
      expect(parseFixedPointBigInt(200_000_000)).toBe(200_000_000n);
      expect(parseFixedPointBigInt(200_000_000n)).toBe(200_000_000n);
      expect(parseFixedPointBigInt('-5')).toBe(-5n);
    });

    it('parses a decimal form rather than truncating it', () => {
      expect(parseFixedPointBigInt('200.0000000')).toBe(2_000_000_000n);
    });

    it('rejects non-numeric values', () => {
      expect(() => parseFixedPointBigInt('nope')).toThrow(InvalidDecimalError);
      expect(() => parseFixedPointBigInt(null)).toThrow(InvalidDecimalError);
    });
  });

  describe('compareScaledToThreshold', () => {
    const threshold = 500_000_000n; // 50.0000000

    it('triggers strictly below for LessThan', () => {
      expect(compareScaledToThreshold(499_999_999n, threshold, 'LessThan')).toBe(true);
      expect(compareScaledToThreshold(500_000_001n, threshold, 'LessThan')).toBe(false);
    });

    it('triggers strictly above for everything else', () => {
      expect(compareScaledToThreshold(500_000_001n, threshold, 'GreaterThan')).toBe(true);
      expect(compareScaledToThreshold(499_999_999n, threshold, 'GreaterThan')).toBe(false);
      // Unknown comparisons keep the historical else-branch (greater-than).
      expect(compareScaledToThreshold(500_000_001n, threshold, 'gte')).toBe(true);
    });

    it('never triggers when the reading equals the threshold', () => {
      expect(compareScaledToThreshold(threshold, threshold, 'LessThan')).toBe(false);
      expect(compareScaledToThreshold(threshold, threshold, 'GreaterThan')).toBe(false);
    });
  });

  describe('evaluateThreshold', () => {
    it('matches the documented claim-boundary behaviour', () => {
      // LessThan: value below threshold triggers.
      expect(evaluateThreshold('200000000', '50.0000000', 'LessThan')).toBe(true);
      expect(evaluateThreshold('800000000', '50.0000000', 'LessThan')).toBe(false);
      // GreaterThan: value above threshold triggers.
      expect(evaluateThreshold('450000000', '30.0000000', 'GreaterThan')).toBe(true);
      expect(evaluateThreshold('150000000', '30.0000000', 'GreaterThan')).toBe(false);
    });

    it('treats an exactly-equal reading as not triggered', () => {
      expect(evaluateThreshold('500000000', '50.0000000', 'LessThan')).toBe(false);
      expect(evaluateThreshold('500000000', '50.0000000', 'GreaterThan')).toBe(false);
    });

    it('is exact for high-precision thresholds (regression)', () => {
      // Reading is 1 unit of 1e-7 below the threshold; must trigger.
      expect(
        evaluateThreshold('500000000', '50.0000001', 'LessThan'),
      ).toBe(true);
      expect(
        evaluateThreshold('500000000', '49.9999999', 'GreaterThan'),
      ).toBe(true);
    });
  });
});
