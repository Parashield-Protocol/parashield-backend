import { Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  let service: PrismaService;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new PrismaService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('onModuleInit', () => {
    it('connects successfully on first attempt', async () => {
      jest.spyOn(service, '$connect').mockResolvedValue(undefined);
      jest.spyOn(service['logger'], 'log');

      await service.onModuleInit();

      expect(service.$connect).toHaveBeenCalledTimes(1);
      expect(service['logger'].log).toHaveBeenCalledWith('Database connection established');
    });

    it('retries and succeeds on a later attempt', async () => {
      const connect = jest.spyOn(service, '$connect');
      connect
        .mockRejectedValueOnce(new Error('connection timeout'))
        .mockRejectedValueOnce(new Error('connection refused'))
        .mockResolvedValue(undefined);
      jest.spyOn(service['logger'], 'warn');
      jest.spyOn(service['logger'], 'log');

      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(3000);
      await Promise.resolve();

      expect(connect).toHaveBeenCalledTimes(3);
      expect(service['logger'].warn).toHaveBeenCalledTimes(2);
      expect(service['logger'].log).toHaveBeenLastCalledWith('Database connection established');
    });

    it('throws after all retries are exhausted', async () => {
      const error = new Error('DB unreachable');
      jest.spyOn(service, '$connect').mockRejectedValue(error);
      jest.spyOn(service['logger'], 'error');

      service.onModuleInit().catch(() => {});
      await jest.advanceTimersByTimeAsync(100_000);

      await expect(Promise.resolve()).resolves.toBeUndefined();
      expect(service.$connect).toHaveBeenCalledTimes(5);
      expect(service['logger'].error).toHaveBeenCalledWith(
        'All database connection retries exhausted',
      );
    });

    it('logs non-Error objects safely', async () => {
      jest.spyOn(service, '$connect').mockRejectedValue('string error');
      jest.spyOn(service['logger'], 'warn');

      service.onModuleInit().catch(() => {});
      await jest.advanceTimersByTimeAsync(100_000);

      expect(service.$connect).toHaveBeenCalledTimes(5);
      expect(service['logger'].warn).toHaveBeenCalledWith(
        expect.stringContaining('attempt 1/5 failed: string error'),
      );
    });
  });

  describe('onModuleDestroy', () => {
    it('disconnects and logs', async () => {
      jest.spyOn(service, '$disconnect').mockResolvedValue(undefined);
      jest.spyOn(service['logger'], 'log');

      await service.onModuleDestroy();

      expect(service.$disconnect).toHaveBeenCalledTimes(1);
      expect(service['logger'].log).toHaveBeenCalledWith('Database connection closed');
    });

    it('propagates disconnect errors', async () => {
      const error = new Error('disconnect failed');
      jest.spyOn(service, '$disconnect').mockRejectedValue(error);

      await expect(service.onModuleDestroy()).rejects.toThrow(error);
    });
  });

  describe('connection pool configuration (#676)', () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = originalEnv;
    });

    it('uses defaults when env vars and URL params are absent', () => {
      delete process.env.DATABASE_CONNECTION_LIMIT;
      delete process.env.DATABASE_POOL_TIMEOUT;
      delete process.env.DATABASE_CONNECT_TIMEOUT;

      const prisma = new PrismaService();
      expect(prisma.poolConfig).toEqual({
        connectionLimit: 10,
        poolTimeout: 10,
        connectTimeout: 5,
      });
    });

    it('respects environment variable overrides', () => {
      process.env.DATABASE_CONNECTION_LIMIT = '25';
      process.env.DATABASE_POOL_TIMEOUT = '30';
      process.env.DATABASE_CONNECT_TIMEOUT = '15';

      const prisma = new PrismaService();
      expect(prisma.poolConfig).toEqual({
        connectionLimit: 25,
        poolTimeout: 30,
        connectTimeout: 15,
      });
    });

    it('gives explicit DATABASE_URL query parameters precedence over env vars', () => {
      process.env.DATABASE_CONNECTION_LIMIT = '25';
      process.env.DATABASE_POOL_TIMEOUT = '30';
      process.env.DATABASE_CONNECT_TIMEOUT = '15';
      process.env.DATABASE_URL =
        'postgresql://user:pass@localhost:5432/db?connection_limit=50&pool_timeout=45&connect_timeout=8';

      const prisma = new PrismaService();
      expect(prisma.poolConfig).toEqual({
        connectionLimit: 50,
        poolTimeout: 45,
        connectTimeout: 8,
      });
    });

    it('logs effective pool configuration on module init', async () => {
      jest.spyOn(service, '$connect').mockResolvedValue(undefined);
      const logSpy = jest.spyOn(service['logger'], 'log');

      await service.onModuleInit();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Prisma connection pool configured: connection_limit='),
      );
    });
  });
});


describe('PrismaService credential rotation', () => {
  const originalEnv = process.env;
  const OLD_URL = 'postgresql://old:old-pass@localhost:5432/db';
  const NEW_URL = 'postgresql://new:new-pass@localhost:5432/db';
  const REPLICA_URL = 'postgresql://ro:ro-pass@replica:5432/db';

  type FakeClient = {
    url: string | undefined;
    $connect: jest.Mock;
    $disconnect: jest.Mock;
    $transaction: jest.Mock;
    policy: { findMany: jest.Mock };
  };

  let clients: FakeClient[];

  function fakeClient(url: string | undefined): FakeClient {
    const client: FakeClient = {
      url,
      $connect: jest.fn().mockResolvedValue(undefined),
      $disconnect: jest.fn().mockResolvedValue(undefined),
      $transaction: jest.fn(function (this: FakeClient) { return Promise.resolve(this.url); }),
      policy: { findMany: jest.fn().mockResolvedValue([url]) },
    };
    clients.push(client);
    return client;
  }

  function clientFor(url: string): FakeClient {
    return clients.find((c) => c.url === url)!;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    process.env = { ...originalEnv, DATABASE_URL: OLD_URL };
    delete process.env.DATABASE_REPLICA_URL;
    delete process.env.DATABASE_ROTATION_DRAIN_MS;
    clients = [];
    jest
      .spyOn(PrismaService.prototype as any, 'createClient')
      .mockImplementation((url) => fakeClient(url as string | undefined));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('forwards PrismaClient calls to the current client, bound to it', async () => {
    const service = new PrismaService();

    await expect(service.policy.findMany()).resolves.toEqual([OLD_URL]);
    await expect(service.$transaction([])).resolves.toBe(OLD_URL);
  });

  it('is a no-op when the credentials have not changed', async () => {
    const service = new PrismaService();

    await expect(service.rotateCredentials()).resolves.toBe(false);
    expect(clients).toHaveLength(1);
  });

  it('reconnects with the new credentials and drains the old client', async () => {
    process.env.DATABASE_ROTATION_DRAIN_MS = '5000';
    const service = new PrismaService();
    const oldClient = clientFor(OLD_URL);

    process.env.DATABASE_URL = NEW_URL;
    await expect(service.rotateCredentials()).resolves.toBe(true);

    const newClient = clientFor(NEW_URL);
    expect(newClient.$connect).toHaveBeenCalledTimes(1);
    await expect(service.policy.findMany()).resolves.toEqual([NEW_URL]);
    // Old pool stays open for in-flight work until the drain period ends.
    expect(oldClient.$disconnect).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(4999);
    expect(oldClient.$disconnect).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(oldClient.$disconnect).toHaveBeenCalledTimes(1);
    expect(newClient.$disconnect).not.toHaveBeenCalled();
  });

  it('keeps the existing connection when the new credentials are rejected, and retries later', async () => {
    const service = new PrismaService();
    const oldClient = clientFor(OLD_URL);
    process.env.DATABASE_URL = NEW_URL;

    const createClient = PrismaService.prototype['createClient'] as jest.Mock;
    createClient.mockImplementationOnce((url: string) => {
      const client = fakeClient(url);
      client.$connect.mockRejectedValue(new Error('P1000: Authentication failed'));
      return client;
    });

    await expect(service.rotateCredentials()).rejects.toThrow('Authentication failed');
    expect(clients[1].$disconnect).toHaveBeenCalledTimes(1);
    await expect(service.policy.findMany()).resolves.toEqual([OLD_URL]);
    expect(oldClient.$disconnect).not.toHaveBeenCalled();

    // The database now accepts the new credentials.
    await expect(service.rotateCredentials()).resolves.toBe(true);
    await expect(service.policy.findMany()).resolves.toEqual([NEW_URL]);
  });

  it('rotates the read replica independently of the primary', async () => {
    process.env.DATABASE_REPLICA_URL = REPLICA_URL;
    const service = new PrismaService();
    const oldReplica = clientFor(REPLICA_URL);

    const NEW_REPLICA_URL = 'postgresql://ro:rotated@replica:5432/db';
    process.env.DATABASE_REPLICA_URL = NEW_REPLICA_URL;
    await expect(service.rotateCredentials()).resolves.toBe(true);

    expect(service.reader).toBe(clientFor(NEW_REPLICA_URL));
    await expect(service.policy.findMany()).resolves.toEqual([OLD_URL]);
    await jest.runOnlyPendingTimersAsync();
    expect(oldReplica.$disconnect).toHaveBeenCalledTimes(1);
    expect(clientFor(OLD_URL).$disconnect).not.toHaveBeenCalled();
  });

  it('serializes concurrent rotations so the swap happens once', async () => {
    const service = new PrismaService();
    process.env.DATABASE_URL = NEW_URL;

    const results = await Promise.all([service.rotateCredentials(), service.rotateCredentials()]);

    expect(results).toEqual([true, false]);
    expect(clients.filter((c) => c.url === NEW_URL)).toHaveLength(1);
  });

  it('disconnects draining clients immediately on shutdown', async () => {
    const service = new PrismaService();
    const oldClient = clientFor(OLD_URL);
    process.env.DATABASE_URL = NEW_URL;
    await service.rotateCredentials();

    await service.onModuleDestroy();

    expect(oldClient.$disconnect).toHaveBeenCalledTimes(1);
    expect(clientFor(NEW_URL).$disconnect).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
