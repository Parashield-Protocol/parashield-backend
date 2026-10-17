import { of } from 'rxjs';
import { BadRequestException } from '@nestjs/common';
import { BigIntSerializerInterceptor, serializeBigInt } from './bigint-serializer.interceptor';
import { parseSafeBigInt, ParseBigIntPipe } from '../pipes/parse-bigint.pipe';

describe('BigIntSerializerInterceptor & Safe BigInt Parsing (#671)', () => {
  let interceptor: BigIntSerializerInterceptor;

  beforeEach(() => {
    interceptor = new BigIntSerializerInterceptor();
  });

  const context = {} as any;

  // Values strictly exceeding Number.MAX_SAFE_INTEGER (9007199254740991)
  const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
  const INT64_MAX = 9223372036854775807n; // 2^63 - 1
  const UINT64_MAX = 18446744073709551615n; // 2^64 - 1
  const UINT128_VAL = 340282366920938463463374607431768211455n; // 2^128 - 1

  describe('interceptor & serializeBigInt', () => {
    it('converts a top-level BigInt to a decimal string', (done) => {
      const next = { handle: () => of(INT64_MAX) };

      interceptor.intercept(context, next).subscribe((result) => {
        expect(result).toBe('9223372036854775807');
        expect(BigInt(result as string)).toBe(INT64_MAX);
        done();
      });
    });

    it('round-trips values larger than Number.MAX_SAFE_INTEGER exactly', (done) => {
      const payload = {
        maxSafe: MAX_SAFE + 100n,
        int64Max: INT64_MAX,
        uint64Max: UINT64_MAX,
        uint128Val: UINT128_VAL,
      };

      const next = { handle: () => of(payload) };

      interceptor.intercept(context, next).subscribe((result: any) => {
        expect(result.maxSafe).toBe((MAX_SAFE + 100n).toString());
        expect(result.int64Max).toBe('9223372036854775807');
        expect(result.uint64Max).toBe('18446744073709551615');
        expect(result.uint128Val).toBe('340282366920938463463374607431768211455');

        // Verify exact lossless round-trip
        expect(BigInt(result.int64Max)).toBe(INT64_MAX);
        expect(BigInt(result.uint64Max)).toBe(UINT64_MAX);
        expect(BigInt(result.uint128Val)).toBe(UINT128_VAL);
        done();
      });
    });

    it('converts BigInt fields nested inside deep objects and arrays', (done) => {
      const nested = {
        id: 'policy-1',
        oracle: {
          reading: {
            value: INT64_MAX,
            history: [
              { tick: 1, val: 100n },
              { tick: 2, val: UINT64_MAX },
            ],
          },
        },
      };

      const next = { handle: () => of(nested) };

      interceptor.intercept(context, next).subscribe((result: any) => {
        expect(result.id).toBe('policy-1');
        expect(result.oracle.reading.value).toBe('9223372036854775807');
        expect(result.oracle.reading.history[0].val).toBe('100');
        expect(result.oracle.reading.history[1].val).toBe('18446744073709551615');
        expect(BigInt(result.oracle.reading.value)).toBe(INT64_MAX);
        done();
      });
    });

    it('converts BigInt inside Set and Map structures', () => {
      const setInput = new Set([1n, INT64_MAX]);
      const mapInput = new Map<string, bigint>([
        ['first', 10n],
        ['second', UINT64_MAX],
      ]);

      expect(serializeBigInt(setInput)).toEqual(['1', '9223372036854775807']);
      expect(serializeBigInt(mapInput)).toEqual({
        first: '10',
        second: '18446744073709551615',
      });
    });

    it('leaves Date, RegExp, and Buffer instances untouched', () => {
      const date = new Date('2026-01-01T00:00:00.000Z');
      const regex = /^test$/i;
      const buffer = Buffer.from('hello');

      expect(serializeBigInt(date)).toBe(date);
      expect(serializeBigInt(regex)).toBe(regex);
      expect(serializeBigInt(buffer)).toBe(buffer);
    });

    it('passes through null, undefined, strings, booleans, and normal numbers', () => {
      const payload = {
        n: null,
        u: undefined,
        s: 'text',
        b: true,
        num: 42,
      };
      expect(serializeBigInt(payload)).toEqual(payload);
    });
  });

  describe('safe input parsing (parseSafeBigInt & ParseBigIntPipe)', () => {
    const pipe = new ParseBigIntPipe();

    it('parses valid numeric integer strings without precision loss', () => {
      const raw = '9223372036854775807';
      const parsed = parseSafeBigInt(raw);
      expect(parsed).toBe(INT64_MAX);
      expect(pipe.transform(raw)).toBe(INT64_MAX);

      const large = '18446744073709551615';
      expect(parseSafeBigInt(large)).toBe(UINT64_MAX);
      expect(pipe.transform(large)).toBe(UINT64_MAX);
    });

    it('parses negative integers correctly', () => {
      expect(parseSafeBigInt('-9223372036854775807')).toBe(-9223372036854775807n);
    });

    it('rejects non-numeric string with 400 BadRequestException', () => {
      expect(() => parseSafeBigInt('abc')).toThrow(BadRequestException);
      expect(() => parseSafeBigInt('123a')).toThrow(BadRequestException);
      expect(() => pipe.transform('not-a-number')).toThrow(BadRequestException);
    });

    it('rejects floating point decimals with 400 BadRequestException', () => {
      expect(() => parseSafeBigInt('123.45')).toThrow(BadRequestException);
      expect(() => parseSafeBigInt('0.5')).toThrow(BadRequestException);
      expect(() => pipe.transform('10.0')).toThrow(BadRequestException);
    });

    it('rejects empty string, null, or undefined with 400 BadRequestException', () => {
      expect(() => parseSafeBigInt('')).toThrow(BadRequestException);
      expect(() => parseSafeBigInt(null)).toThrow(BadRequestException);
      expect(() => parseSafeBigInt(undefined)).toThrow(BadRequestException);
      expect(() => pipe.transform('')).toThrow(BadRequestException);
    });

    it('never converts through Number so precision above 2^53 is preserved exactly', () => {
      // 9007199254740993 cannot be represented accurately as a JavaScript Number
      // Number("9007199254740993") === 9007199254740992
      const precisionSensitive = '9007199254740993';
      const parsed = parseSafeBigInt(precisionSensitive);
      expect(parsed.toString()).toBe('9007199254740993');
      expect(parsed).toBe(9007199254740993n);
      expect(parsed).not.toBe(BigInt(Number(precisionSensitive)));
    });
  });
});
