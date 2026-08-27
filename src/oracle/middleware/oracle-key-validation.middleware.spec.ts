import { BadRequestException } from '@nestjs/common';
import { OracleKeyValidationMiddleware } from './oracle-key-validation.middleware';

describe('OracleKeyValidationMiddleware (#473)', () => {
  const middleware = new OracleKeyValidationMiddleware();
  const res = {} as any;

  function req(overrides: { query?: Record<string, unknown>; params?: Record<string, unknown> }) {
    return { query: overrides.query ?? {}, params: overrides.params ?? {} } as any;
  }

  it('calls next() when no key is present on either query or params', () => {
    const next = jest.fn();
    middleware.use(req({}), res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('calls next() for a well-formed query key', () => {
    const next = jest.fn();
    middleware.use(req({ query: { key: 'rainfall:-0.0917,34.7679:2026-06' } }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('decodes a URL-encoded query key before validating it', () => {
    const next = jest.fn();
    const encoded = encodeURIComponent('rainfall:-0.0917,34.7679:2026-06');
    middleware.use(req({ query: { key: encoded } }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('calls next() for a well-formed path key', () => {
    const next = jest.fn();
    middleware.use(req({ params: { key: 'flight:KQ100:2026-06-27' } }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('throws BadRequestException for a malformed query key', () => {
    const next = jest.fn();
    expect(() => middleware.use(req({ query: { key: 'not-an-oracle-key' } }), res, next)).toThrow(
      BadRequestException,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('throws BadRequestException for a malformed path key', () => {
    const next = jest.fn();
    expect(() => middleware.use(req({ params: { key: 'rainfall:9999,9999:2026-06' } }), res, next)).toThrow(
      BadRequestException,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('prefers the query key over the path key when both are somehow present', () => {
    const next = jest.fn();
    middleware.use(
      req({ query: { key: 'flight:KQ100:2026-06-27' }, params: { key: 'not-an-oracle-key' } }),
      res,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});
