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
});
