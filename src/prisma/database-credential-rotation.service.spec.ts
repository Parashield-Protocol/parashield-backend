import { Logger } from '@nestjs/common';
import { DatabaseCredentialRotationService } from './database-credential-rotation.service';
import { PrismaService } from './prisma.service';

describe('DatabaseCredentialRotationService', () => {
  const originalEnv = process.env;
  const OLD_URL = 'postgresql://old:old-pass@localhost:5432/db';
  const NEW_URL = 'postgresql://new:new-pass@localhost:5432/db';

  let fetchMock: jest.Mock;
  let prisma: { rotateCredentials: jest.Mock };
  let service: DatabaseCredentialRotationService;

  function vaultReturns(data: Record<string, unknown>) {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: jest.fn().mockResolvedValue({ data: { data } }),
    });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    process.env = {
      ...originalEnv,
      VAULT_ADDR: 'https://vault.example.com',
      VAULT_TOKEN: 's.token',
      VAULT_KV_PATH: 'secret/data/parashield',
      DATABASE_URL: OLD_URL,
      JWT_SECRET: 'startup-jwt',
    };
    delete process.env.VAULT_REFRESH_INTERVAL_MS;
    delete process.env.DATABASE_REPLICA_URL;
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    prisma = { rotateCredentials: jest.fn().mockResolvedValue(true) };
    service = new DatabaseCredentialRotationService(prisma as unknown as PrismaService);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    service.onModuleDestroy();
    process.env = originalEnv;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('applies rotated database credentials from Vault and reconnects', async () => {
    vaultReturns({ DATABASE_URL: NEW_URL, JWT_SECRET: 'rotated-jwt' });

    await expect(service.refresh()).resolves.toBe(true);

    expect(process.env.DATABASE_URL).toBe(NEW_URL);
    expect(prisma.rotateCredentials).toHaveBeenCalledTimes(1);
    // Only database credentials are applied at runtime.
    expect(process.env.JWT_SECRET).toBe('startup-jwt');
  });

  it('does not reconnect when the credentials are unchanged', async () => {
    vaultReturns({ DATABASE_URL: OLD_URL });

    await expect(service.refresh()).resolves.toBe(false);
    expect(prisma.rotateCredentials).not.toHaveBeenCalled();
  });

  it('keeps current credentials when Vault is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(service.refresh()).resolves.toBe(false);
    expect(process.env.DATABASE_URL).toBe(OLD_URL);
    expect(prisma.rotateCredentials).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('keeping current credentials'),
    );
  });

  it('restores the previous credentials when reconnecting fails, so the next refresh retries', async () => {
    vaultReturns({ DATABASE_URL: NEW_URL });
    prisma.rotateCredentials.mockRejectedValueOnce(new Error('P1000: Authentication failed'));

    await expect(service.refresh()).resolves.toBe(false);
    expect(process.env.DATABASE_URL).toBe(OLD_URL);

    await expect(service.refresh()).resolves.toBe(true);
    expect(process.env.DATABASE_URL).toBe(NEW_URL);
    expect(prisma.rotateCredentials).toHaveBeenCalledTimes(2);
  });

  it('polls Vault on the configured interval', async () => {
    process.env.VAULT_REFRESH_INTERVAL_MS = '60000';
    vaultReturns({ DATABASE_URL: NEW_URL });
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(59_999);
    expect(fetchMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prisma.rotateCredentials).toHaveBeenCalledTimes(1);
  });

  it('does not poll when Vault is not configured or polling is disabled', async () => {
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    service.onModuleDestroy();

    process.env.VAULT_REFRESH_INTERVAL_MS = '0';
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);

    delete process.env.VAULT_REFRESH_INTERVAL_MS;
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
    delete process.env.VAULT_KV_PATH;
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('shares one refresh between overlapping calls', async () => {
    vaultReturns({ DATABASE_URL: NEW_URL });

    await Promise.all([service.refresh(), service.refresh()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prisma.rotateCredentials).toHaveBeenCalledTimes(1);
  });
});
