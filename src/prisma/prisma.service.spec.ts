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

