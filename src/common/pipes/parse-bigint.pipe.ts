import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

/**
 * Safely parses a string or numeric value to BigInt (#671).
 * Rejects non-numeric input or floats with a 400 BadRequestException.
 * Never converts through Number to prevent precision loss above 2^53.
 */
export function parseSafeBigInt(value: unknown, fieldName: string = 'value'): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (value === null || value === undefined || value === '') {
    throw new BadRequestException(`${fieldName} must be a valid integer string`);
  }
  const str = String(value).trim();
  // Valid integer: optional leading minus, followed by one or more digits
  if (!/^-?\d+$/.test(str)) {
    throw new BadRequestException(`${fieldName} must be a valid numeric integer string without decimals`);
  }
  try {
    return BigInt(str);
  } catch {
    throw new BadRequestException(`${fieldName} could not be parsed to BigInt`);
  }
}

@Injectable()
export class ParseBigIntPipe implements PipeTransform<string, bigint> {
  transform(value: string): bigint {
    return parseSafeBigInt(value, 'parameter');
  }
}
