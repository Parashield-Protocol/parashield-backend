import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedisConnectionService, runtimeRetryDelay } from './redis-connection.service';
import { registerRedisErrorHandler } from './redis.module';
import { RedisStartupConnectionError } from './redis-startup';

/** Fake ioredis-like client. */
class FakeRedisClient {
  attempts = 0;
  disconnects = 0;
  quits = 0;
  status = 'wait';
  readonly errorHandlers: Array<(err: Error) => void> = [];
  options: Record<string, unknown> = {};

  constructor(private readonly failuresBeforeSuccess: number) {}

  connect = jest.fn(async () => {
    this.attempts += 1;
    if (this.attempts <= this.failuresBeforeSuccess) {
      throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    }
    this.status = 'ready';
  });

  disconnect = jest.fn((_reconnect?: boolean) => {
    this.disconnects += 1;
    this.status = 'end';
  });

  quit = jest.fn(async () => {
    this.quits += 1;
    this.status = 'end';
  });

  on = jest.fn((event: string, handler: (err: Error) => void) => {
    if (event === 'error') this.errorHandlers.push(handler);
    return this;
  });
}

async function buildService(
  failuresBeforeSuccess: number,
  env: Record<string, string> = {},
): Promise<{ service: RedisConnectionService; client: FakeRedisClient }> {
  const client = new FakeRedisClient(failuresBeforeSuccess);
  const config = { get: jest.fn((key: string) => env[key]) };

  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      RedisConnectionService,
      { provide: 'REDIS_CLIENT', useValue: client },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();

  const service = moduleRef.get(RedisConnectionService);
  // No real sleeps in tests.
  jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'random').mockReturnValue(1);
  jest.spyOn(service as any, 'now').mockReturnValue(0);
  return { service, client };
}

describe('RedisConnectionService (#710)', () => {
  afterEach(() => jest.clearAllMocks());

  it('starts when Redis is available on the first attempt', async () => {
    const { service, client } = await buildService(0, { REDIS_URL: 'redis://localhost:6379' });

    await expect(service.onModuleInit()).resolves.toBeUndefined();

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.options.retryStrategy).toBe(runtimeRetryDelay);
  });

  it('starts when Redis becomes available after N failed attempts', async () => {
    const { service, client } = await buildService(2, {
      REDIS_URL: 'redis://localhost:6379',
      REDIS_STARTUP_MAX_ATTEMPTS: '5',
    });

    await expect(service.onModuleInit()).resolves.toBeUndefined();

    expect(client.connect).toHaveBeenCalledTimes(3);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('fails after exactly the configured maximum attempts', async () => {
    const { service, client } = await buildService(Infinity, {
      REDIS_URL: 'redis://localhost:6379',
      REDIS_STARTUP_MAX_ATTEMPTS: '3',
    });

    await expect(service.onModuleInit()).rejects.toBeInstanceOf(RedisStartupConnectionError);
    expect(client.connect).toHaveBeenCalledTimes(3);
    // Failed client is cleaned up so no connection/listener is leaked.
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('honors the configured retry values', async () => {
    const { service, client } = await buildService(Infinity, {
      REDIS_URL: 'redis://localhost:6379',
      REDIS_STARTUP_MAX_ATTEMPTS: '2',
      REDIS_STARTUP_INITIAL_DELAY_MS: '10',
      REDIS_STARTUP_MAX_DELAY_MS: '1000',
    });

    await expect(service.onModuleInit()).rejects.toBeInstanceOf(RedisStartupConnectionError);
    expect(client.connect).toHaveBeenCalledTimes(2);
    const sleep = (service as any).sleep as jest.Mock;
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('produces an actionable error naming host and port', async () => {
    const { service } = await buildService(Infinity, {
      REDIS_URL: 'redis://redis.internal:6380',
      REDIS_STARTUP_MAX_ATTEMPTS: '2',
    });

    await expect(service.onModuleInit()).rejects.toThrow(/redis\.internal:6380/);
  });

  it('never includes credentials in the failure error', async () => {
    const { service } = await buildService(Infinity, {
      REDIS_URL: 'redis://admin:supersecret@redis.internal:6380',
      REDIS_STARTUP_MAX_ATTEMPTS: '2',
    });

    const error = await service.onModuleInit().then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(error).toBeInstanceOf(RedisStartupConnectionError);
    expect(error!.message).not.toContain('supersecret');
    expect(error!.message).not.toContain('admin');
    expect(error!.message).not.toContain('redis://');
    expect(error!.message).toContain('redis.internal:6380');
  });

  it('closes the client on shutdown exactly once (idempotent)', async () => {
    const { service, client } = await buildService(0, { REDIS_URL: 'redis://localhost:6379' });
    await service.onModuleInit();

    await service.onModuleDestroy();
    await service.onModuleDestroy();

    expect(client.quit).toHaveBeenCalledTimes(1);
    expect(client.disconnect).not.toHaveBeenCalled();
  });
});

describe('registerRedisErrorHandler (#710)', () => {
  it('always attaches an error listener and is idempotent', () => {
    const listeners: Array<(err: Error) => void> = [];
    const client = {
      on: jest.fn((event: string, handler: (err: Error) => void) => {
        if (event === 'error') listeners.push(handler);
        return client;
      }),
    } as any;

    registerRedisErrorHandler(client);
    registerRedisErrorHandler(client);

    expect(listeners).toHaveLength(1);
    // Emitting must not throw (i.e. the error is handled).
    expect(() => listeners[0](new Error('boom'))).not.toThrow();
  });
});
