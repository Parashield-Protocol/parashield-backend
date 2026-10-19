import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserThrottlerGuard } from './user-throttler.guard';

class TestGuard extends UserThrottlerGuard {
  public run(props: any) {
    return this.handleRequest(props);
  }
}

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ setHeader: jest.fn() }),
    }),
    getClass: () => class TestController {},
    getHandler: () => function testHandler() {},
  } as unknown as ExecutionContext;
}

describe('UserThrottlerGuard differentiated limits', () => {
  const increment = jest.fn().mockResolvedValue({
    totalHits: 1,
    timeToExpire: 60,
    isBlocked: false,
    timeToBlockExpire: 0,
  });
  const jwtService = { verifyAsync: jest.fn() };
  const guard = new TestGuard(
    [{ name: 'default', ttl: 60_000, limit: 60 }],
    { increment } as any,
    new Reflector(),
    jwtService as any,
  );

  const requestProps = (request: Record<string, unknown>) => ({
    context: contextFor(request),
    limit: 60,
    ttl: 60_000,
    blockDuration: 60_000,
    throttler: { name: 'default' },
    getTracker: jest.fn(),
    generateKey: jest.fn((_context, tracker) => `rate:${tracker}`),
  });

  beforeAll(async () => guard.onModuleInit());

  beforeEach(() => jest.clearAllMocks());

  it('keeps anonymous callers in the lower per-IP bucket', async () => {
    await guard.run(requestProps({ ip: '203.0.113.10', headers: {} }));
    expect(increment).toHaveBeenCalledWith(
      'rate:203.0.113.10', 60_000, 60, 60_000, 'default',
    );
  });

  it('gives authenticated callers a higher per-user limit', async () => {
    await guard.run(requestProps({
      ip: '203.0.113.10',
      wallet: 'GALICE',
      headers: {},
    }));
    expect(increment).toHaveBeenCalledWith(
      'rate:user:GALICE', 60_000, 300, 60_000, 'default',
    );
  });

  it('uses independent buckets for authenticated users sharing an IP', async () => {
    await guard.run(requestProps({ ip: '203.0.113.10', wallet: 'GALICE', headers: {} }));
    await guard.run(requestProps({ ip: '203.0.113.10', wallet: 'GBOB', headers: {} }));
    expect(increment.mock.calls.map((call) => call[0])).toEqual([
      'rate:user:GALICE',
      'rate:user:GBOB',
    ]);
  });
});
