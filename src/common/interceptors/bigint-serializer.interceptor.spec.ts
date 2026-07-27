import { of } from 'rxjs';
import { BigIntSerializerInterceptor } from './bigint-serializer.interceptor';

describe('BigIntSerializerInterceptor', () => {
  let interceptor: BigIntSerializerInterceptor;

  beforeEach(() => {
    interceptor = new BigIntSerializerInterceptor();
  });

  const context = {} as any;

  it('converts a top-level BigInt to a string', (done) => {
    const next = { handle: () => of(10n) };

    interceptor.intercept(context, next).subscribe((result) => {
      expect(result).toBe('10');
      done();
    });
  });

  it('converts BigInt fields nested inside an object', (done) => {
    const next = { handle: () => of({ id: 'abc', value: 123456789012345678901n }) };

    interceptor.intercept(context, next).subscribe((result) => {
      expect(result).toEqual({ id: 'abc', value: '123456789012345678901' });
      done();
    });
  });

  it('converts BigInt values inside arrays', (done) => {
    const next = { handle: () => of([1n, { value: 2n }]) };

    interceptor.intercept(context, next).subscribe((result) => {
      expect(result).toEqual(['1', { value: '2' }]);
      done();
    });
  });

  it('leaves Date instances untouched', (done) => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const next = { handle: () => of({ createdAt: date }) };

    interceptor.intercept(context, next).subscribe((result: any) => {
      expect(result.createdAt).toBe(date);
      done();
    });
  });

  it('passes through primitives and null unchanged', (done) => {
    const next = { handle: () => of({ a: null, b: 'text', c: 42, d: true }) };

    interceptor.intercept(context, next).subscribe((result) => {
      expect(result).toEqual({ a: null, b: 'text', c: 42, d: true });
      done();
    });
  });
});
