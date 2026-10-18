import { BadRequestException } from '@nestjs/common';

/**
 * #712 — Exact decimal arithmetic for oracle threshold comparison.
 *
 * Product thresholds are stored as `Decimal(20,7)` and oracle reading values as
 * 7-decimal fixed point. Comparing them via `parseFloat(threshold) * 1e7` loses
 * precision (binary floating point cannot represent most decimal fractions), so
 * a threshold the operator typed as `0.3000000` can end up on the wrong side of
 * an exact boundary and pay out (or not) incorrectly.
 *
 * Everything here works on `BigInt` scaled by 10^`DEFAULT_DECIMAL_SCALE`, which
 * is exact for any value representable at 7 decimal places.
 */

/** Decimal places used across the money/oracle contracts (Stellar USDC precision). */
export const DEFAULT_DECIMAL_SCALE = 7;

/** Raised when a value cannot be interpreted as a decimal number. */
export class InvalidDecimalError extends BadRequestException {
  constructor(message = 'Value is not a valid decimal number') {
    super(message);
    this.name = 'InvalidDecimalError';
  }
}

/** `true` if the value has an exponent, e.g. `1e-7` / `1.2E+3`. */
const EXPONENT_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)[eE][+-]?\d+$/;
/** `true` if the value is a plain (non-exponent) decimal, e.g. `-12.34` / `.5` / `5.`. */
const PLAIN_DECIMAL_PATTERN = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/;

/**
 * Rewrite scientific notation (`1e-7`, `2.5E+3`) into plain decimal notation
 * without any rounding, so the caller's regexes never need to know about it.
 */
function expandExponent(input: string): string {
  if (!EXPONENT_PATTERN.test(input)) return input;

  const match = /^([+-]?)(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(input);
  if (!match) return input;

  const negative = match[1] === '-';
  const intPart = match[2] ?? '';
  const fracPart = match[3] ?? '';
  const exponent = parseInt(match[4], 10);

  const digits = intPart + fracPart;
  const pointPosition = intPart.length + exponent;

  let plain: string;
  if (pointPosition <= 0) {
    plain = `0.${'0'.repeat(-pointPosition)}${digits}`;
  } else if (pointPosition >= digits.length) {
    plain = `${digits}${'0'.repeat(pointPosition - digits.length)}`;
  } else {
    plain = `${digits.slice(0, pointPosition)}.${digits.slice(pointPosition)}`;
  }

  return negative ? `-${plain}` : plain;
}

/** Normalise any accepted input type to a plain (non-exponent) decimal string. */
function toPlainDecimalString(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InvalidDecimalError(`Value is not a finite number: ${value}`);
    }
    return expandExponent(String(value));
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      throw new InvalidDecimalError('Value is an empty string');
    }
    return expandExponent(trimmed);
  }

  // Accept decimal-like objects (e.g. Prisma.Decimal) via their string form,
  // but not arbitrary objects whose default toString is "[object Object]".
  if (value !== null && typeof value === 'object') {
    const stringified = String(value).trim();
    if (stringified !== '' && !stringified.startsWith('[object ')) {
      return expandExponent(stringified);
    }
  }

  throw new InvalidDecimalError(
    `Unsupported decimal value type: ${value === null ? 'null' : typeof value}`,
  );
}

/**
 * Parse a decimal value into an exact `BigInt` scaled by 10^`scale`
 * (default {@link DEFAULT_DECIMAL_SCALE}).
 *
 * Accepts a string, finite number or bigint. Sign is preserved; scientific
 * notation (including the `1e-7` form that `String(number)` produces for small
 * floats) is expanded exactly. Digits beyond `scale` are rounded half-away-from
 * -zero, matching how the value would be stored in a 7-dp column.
 *
 * Throws {@link InvalidDecimalError} for empty strings, `NaN`, `Infinity` and
 * anything that is not a number at all.
 *
 * @example
 * parseDecimalScaled('50.0000000') // 500000000n
 * parseDecimalScaled('0.0000001')  // 1n
 * parseDecimalScaled(50)           // 500000000n
 */
export function parseDecimalScaled(
  value: unknown,
  scale: number = DEFAULT_DECIMAL_SCALE,
): bigint {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new InvalidDecimalError(`Invalid decimal scale: ${scale}`);
  }

  const plain = toPlainDecimalString(value);
  const match = PLAIN_DECIMAL_PATTERN.exec(plain);
  if (!match) {
    throw new InvalidDecimalError(`Value is not a valid decimal number: "${plain}"`);
  }

  const sign = match[1] === '-' ? -1n : 1n;
  const intPart = match[2] ?? '0';
  const fracPart = match[3] ?? match[4] ?? '';

  const combined = intPart + fracPart;
  if (!/\d/.test(combined)) {
    throw new InvalidDecimalError(`Value is not a valid decimal number: "${plain}"`);
  }

  let mantissa = BigInt(combined);
  const excessDigits = fracPart.length - scale;

  if (excessDigits > 0) {
    const divisor = 10n ** BigInt(excessDigits);
    const quotient = mantissa / divisor;
    const remainder = mantissa % divisor;
    // Round half away from zero.
    mantissa = remainder * 2n >= divisor ? quotient + 1n : quotient;
  } else if (excessDigits < 0) {
    mantissa = mantissa * 10n ** BigInt(-excessDigits);
  }

  return sign * mantissa;
}

/**
 * Parse an already-scaled oracle reading value (an integer count of 10^-scale
 * units, e.g. `200000000` for 20.0 at scale 7) into a `BigInt`.
 *
 * Accepts the exact integer string form produced by `BigInt#toString`, a bigint
 * or an integer number. A value carrying a decimal point is parsed as a decimal
 * (so a caller passing `200.0000000` still works) rather than silently truncated.
 */
export function parseFixedPointBigInt(
  value: unknown,
  scale: number = DEFAULT_DECIMAL_SCALE,
): bigint {
  if (typeof value === 'bigint') return value;

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      return parseDecimalScaled(value, scale);
    }
    return BigInt(value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[+-]?\d+$/.test(trimmed)) {
      return BigInt(trimmed);
    }
    return parseDecimalScaled(trimmed, scale);
  }

  throw new InvalidDecimalError(
    `Unsupported reading value type: ${value === null ? 'null' : typeof value}`,
  );
}

/**
 * Compare two values already scaled by 10^`scale`, preserving the trigger
 * semantics used across the app: `'LessThan'` triggers when the reading is
 * strictly below the threshold, anything else triggers when it is strictly
 * above. A reading exactly equal to the threshold never triggers.
 */
export function compareScaledToThreshold(
  readingScaled: bigint,
  thresholdScaled: bigint,
  comparison: unknown,
): boolean {
  return comparison === 'LessThan'
    ? readingScaled < thresholdScaled
    : readingScaled > thresholdScaled;
}

/**
 * Convenience wrapper that parses `threshold`/`reading` exactly and compares
 * them. Accepts the raw product threshold (any decimal form) and the raw oracle
 * reading value (7-dp fixed point). Throws {@link InvalidDecimalError} if either
 * value is not numeric — callers that must degrade gracefully should parse the
 * threshold themselves and use {@link compareScaledToThreshold}.
 */
export function evaluateThreshold(
  reading: unknown,
  threshold: unknown,
  comparison: unknown,
  scale: number = DEFAULT_DECIMAL_SCALE,
): boolean {
  return compareScaledToThreshold(
    parseFixedPointBigInt(reading, scale),
    parseDecimalScaled(threshold, scale),
    comparison,
  );
}
