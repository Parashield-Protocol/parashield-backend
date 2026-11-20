import { Prisma } from '@prisma/client';
import {
  InvalidDecimalError,
  evaluateThreshold,
  parseDecimalScaled,
  parseFixedPointBigInt,
} from './decimal';

describe('decimal utils coverage (#909)', () => {
  describe('expandExponent via parseDecimalScaled', () => {
    it('expands 1e-7 from a number and a string', () => {
      expect(parseDecimalScaled(1e-7)).toBe(1n);
      expect(parseDecimalScaled('1e-7')).toBe(1n);
    });

    it('expands 2.5E+3 with an upper-case exponent', () => {
      expect(parseDecimalScaled('2.5E+3')).toBe(25_000_000_000n);
    });

    it('expands a negative mantissa with a negative exponent', () => {
      expect(parseDecimalScaled('-2.5E-3')).toBe(-25_000n);
    });

    it('expands 1e100 exactly', () => {
      expect(parseDecimalScaled('1e100')).toBe(10n ** 107n);
      expect(parseDecimalScaled(1e100)).toBe(10n ** 107n);
    });
  });

  describe('parseDecimalScaled rounding at the scale boundary', () => {
    it('rounds a half digit up', () => {
      expect(parseDecimalScaled('0.12345675')).toBe(1_234_568n);
    });

    it('rounds half away from zero for negatives', () => {
      expect(parseDecimalScaled('-0.00000005')).toBe(-1n);
    });

    it('rounds sub-half digits to zero, including for negatives', () => {
      expect(parseDecimalScaled('0.00000004')).toBe(0n);
      expect(parseDecimalScaled('-0.00000004')).toBe(0n);
    });

    it('carries a rounding overflow into the integer part', () => {
      expect(parseDecimalScaled('9.99999995')).toBe(100_000_000n);
    });

    it('honours rounding with a custom scale', () => {
      expect(parseDecimalScaled('1.005', 2)).toBe(101n);
      expect(parseDecimalScaled('0.5', 0)).toBe(1n);
      expect(parseDecimalScaled('-0.5', 0)).toBe(-1n);
    });

    it('truncates beyond the scale when requested', () => {
      expect(parseDecimalScaled('1.23456789', 7, 'truncate')).toBe(12_345_678n);
      expect(parseDecimalScaled('-1.23456789', 7, 'truncate')).toBe(-12_345_678n);
    });
  });

  describe('parseFixedPointBigInt', () => {
    it('passes bigint and integer number values through exactly', () => {
      expect(parseFixedPointBigInt(0)).toBe(0n);
      expect(parseFixedPointBigInt(-1n)).toBe(-1n);
    });

    it('trims surrounding whitespace from integer strings', () => {
      expect(parseFixedPointBigInt('  42  ')).toBe(42n);
    });

    it('parses a fractional number as a decimal at the default scale', () => {
      expect(parseFixedPointBigInt(2.5)).toBe(25_000_000n);
    });

    it('truncates oracle reading values beyond the scale', () => {
      expect(parseFixedPointBigInt('0.12345675')).toBe(1_234_567n);
    });
  });

  describe('evaluateThreshold with Prisma.Decimal inputs', () => {
    it('compares a reading against a Prisma.Decimal threshold exactly', () => {
      // Reading is 1 unit of 1e-7 below the threshold.
      expect(
        evaluateThreshold('500000000', new Prisma.Decimal('50.0000001'), 'LessThan'),
      ).toBe(true);
      expect(
        evaluateThreshold('500000000', new Prisma.Decimal('49.9999999'), 'GreaterThan'),
      ).toBe(true);
    });

    it('does not trigger on an exact boundary with a Prisma.Decimal threshold', () => {
      expect(evaluateThreshold('500000000', new Prisma.Decimal('50'), 'LessThan')).toBe(false);
      expect(evaluateThreshold('500000000', new Prisma.Decimal('50'), 'GreaterThan')).toBe(false);
    });

    it('respects a custom scale', () => {
      expect(evaluateThreshold('150', '1.5', 'GreaterThan', 2)).toBe(false);
      expect(evaluateThreshold('150', '1.5', 'LessThan', 2)).toBe(false);
    });

    it('throws InvalidDecimalError for a non-numeric threshold', () => {
      expect(() => evaluateThreshold('100', 'abc', 'LessThan')).toThrow(InvalidDecimalError);
    });
  });
});