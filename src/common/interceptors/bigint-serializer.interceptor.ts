import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * BigIntSerializerInterceptor — recursively converts BigInt values in
 * response payloads to decimal strings so they survive Express's JSON.stringify
 * without precision loss or runtime crashes (#671).
 *
 * Scoped centrally to the response pipeline and framework replacer instead of
 * mutating BigInt.prototype globally.
 */
@Injectable()
export class BigIntSerializerInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => serializeBigInt(data)));
  }
}

/**
 * Recursively converts BigInt values to decimal strings.
 * Handles top-level values, nested objects, arrays, Sets, and Maps.
 * Leaves Dates, Buffers, and other primitives untouched.
 */
export function serializeBigInt(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString(10);
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(serializeBigInt);
  }

  if (value instanceof Date || value instanceof RegExp) {
    return value;
  }

  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Set) {
    return Array.from(value).map(serializeBigInt);
  }

  if (value instanceof Map) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      result[String(k)] = serializeBigInt(v);
    }
    return result;
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = serializeBigInt(val);
    }
    return result;
  }

  return value;
}
