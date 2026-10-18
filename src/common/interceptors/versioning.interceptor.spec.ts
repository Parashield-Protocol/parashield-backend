import { BadRequestException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { VersioningInterceptor } from './versioning.interceptor';
import { API_VERSION_HEADER } from '../versioning/api-version';

function makeContext(url: string, headers: Record<string, unknown> = {}) {
  const setHeader = jest.fn();
  const res = { setHeader, headersSent: false };
  const req = { originalUrl: url, url, headers };
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as any;
  return { ctx, setHeader };
}

describe('VersioningInterceptor (#713)', () => {
  const interceptor = new VersioningInterceptor({} as any);

  it('sets X-API-Version before the handler runs (so streamed responses get it)', () => {
    const { ctx, setHeader } = makeContext('/api/v1/policies');

    let headerSetBeforeHandle = false;
    const next = {
      handle: jest.fn(() => {
        headerSetBeforeHandle = setHeader.mock.calls.length > 0;
        return of({ success: true });
      }),
    };

    interceptor.intercept(ctx, next as any);

    expect(headerSetBeforeHandle).toBe(true);
    expect(setHeader).toHaveBeenCalledWith(API_VERSION_HEADER, '1.0.0');
  });

  it('marks v1 as deprecated', () => {
    const { ctx, setHeader } = makeContext('/api/v1/policies');
    interceptor.intercept(ctx, { handle: () => of({}) } as any);

    expect(setHeader).toHaveBeenCalledWith('Deprecation', 'true');
    expect(setHeader).toHaveBeenCalledWith('Link', '</api/v2>; rel="successor"');
  });

  it('serves v2 with the right version and no deprecation headers', () => {
    const { ctx, setHeader } = makeContext('/api/v2/policies');
    interceptor.intercept(ctx, { handle: () => of({}) } as any);

    expect(setHeader).toHaveBeenCalledWith(API_VERSION_HEADER, '2.0.0');
    expect(setHeader).not.toHaveBeenCalledWith('Deprecation', expect.anything());
  });

  it('honours an explicit x-api-version header on an unversioned path', () => {
    const { ctx, setHeader } = makeContext('/health', { 'x-api-version': 'v2' });
    interceptor.intercept(ctx, { handle: () => of({}) } as any);

    expect(setHeader).toHaveBeenCalledWith(API_VERSION_HEADER, '2.0.0');
  });

  it('rejects unsupported versions before handling', () => {
    const { ctx } = makeContext('/api/v3/policies');
    const next = { handle: jest.fn(() => of({})) };

    expect(() => interceptor.intercept(ctx, next as any)).toThrow(BadRequestException);
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('adds the version to a success envelope metadata', async () => {
    const { ctx } = makeContext('/api/v1/policies');
    const data: any = { success: true };

    const result = await lastValueFrom(
      interceptor.intercept(ctx, { handle: () => of(data) } as any),
    );

    expect(result.metadata.version).toBe('1.0.0');
  });
});
