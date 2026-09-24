import { ExecutionContext, HttpException } from '@nestjs/common';
import { ThrottleGuard } from './throttle.guard';

function contextFor(req: Record<string, unknown>): ExecutionContext {
  const res = { setHeader: jest.fn() };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
}

describe('ThrottleGuard — client IP resolution (#494)', () => {
  let guard: ThrottleGuard;

  beforeEach(() => {
    guard = new ThrottleGuard();
  });

  afterEach(() => {
    guard.onModuleDestroy();
  });

  it('ignores a spoofed X-Forwarded-For header and keys on req.ip', () => {
    for (let i = 0; i < 60; i++) {
      guard.canActivate(
        contextFor({ ip: '203.0.113.7', headers: { 'x-forwarded-for': `10.0.0.${i}` } }),
      );
    }

    expect(() =>
      guard.canActivate(
        contextFor({ ip: '203.0.113.7', headers: { 'x-forwarded-for': '1.2.3.4' } }),
      ),
    ).toThrow(HttpException);
  });

  it('falls back to the socket address when req.ip is unavailable', () => {
    for (let i = 0; i < 60; i++) {
      guard.canActivate(contextFor({ headers: {}, socket: { remoteAddress: '198.51.100.1' } }));
    }

    expect(() =>
      guard.canActivate(contextFor({ headers: {}, socket: { remoteAddress: '198.51.100.1' } })),
    ).toThrow(HttpException);
    expect(
      guard.canActivate(contextFor({ headers: {}, socket: { remoteAddress: '198.51.100.2' } })),
    ).toBe(true);
  });
});
