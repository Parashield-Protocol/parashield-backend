import { HttpException } from '@nestjs/common';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const KEEPER_ADDRESS = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';

  function build(overrides?: { balance?: string; dbFails?: boolean; rpcFails?: boolean; minBalance?: string }) {
    const prisma = {
      $queryRaw: overrides?.dbFails
        ? jest.fn().mockRejectedValue(new Error('connection refused'))
        : jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    const stellar = {
      keeperKeypair: { publicKey: () => KEEPER_ADDRESS },
      getAccountBalance: overrides?.rpcFails
        ? jest.fn().mockRejectedValue(new Error('RPC unreachable'))
        : jest.fn().mockResolvedValue(overrides?.balance ?? '100.0000000'),
    };
    const config = {
      get: jest.fn((key: string) => (key === 'KEEPER_MIN_BALANCE_XLM' ? overrides?.minBalance : undefined)),
    };

    return new HealthController(prisma as any, stellar as any, config as any);
  }

  it('returns 200/ok when DB and Stellar RPC are both healthy with sufficient keeper balance', async () => {
    const controller = build({ balance: '50' });

    const body = await controller.check();

    expect(body.status).toBe('ok');
    expect(body.checks.database.status).toBe('ok');
    expect(body.checks.stellar.status).toBe('ok');
    expect(body.checks.stellar.keeperBalanceXlm).toBe('50');
  });

  it('throws a 503 HttpException when the DB query fails', async () => {
    const controller = build({ dbFails: true });

    await expect(controller.check()).rejects.toThrow(HttpException);
    await expect(controller.check()).rejects.toMatchObject({
      response: expect.objectContaining({
        checks: expect.objectContaining({ database: expect.objectContaining({ status: 'error' }) }),
      }),
    });
  });

  it('throws a 503 HttpException when the Stellar RPC call fails', async () => {
    const controller = build({ rpcFails: true });

    await expect(controller.check()).rejects.toThrow(HttpException);
    await expect(controller.check()).rejects.toMatchObject({
      response: expect.objectContaining({
        checks: expect.objectContaining({ stellar: expect.objectContaining({ status: 'error' }) }),
      }),
    });
  });

  // #191 — RPC reachability alone doesn't catch a keeper account that's
  // been drained of XLM; the balance-floor check is what actually protects
  // against "status: ok while every real submission fails to cover fees."
  it('#191 — reports degraded when keeper balance is below the configured floor', async () => {
    const controller = build({ balance: '0.5', minBalance: '5' });

    await expect(controller.check()).rejects.toThrow(HttpException);
    await expect(controller.check()).rejects.toMatchObject({
      response: expect.objectContaining({
        checks: expect.objectContaining({
          stellar: expect.objectContaining({
            status: 'error',
            keeperBalanceXlm: '0.5',
            error: expect.stringContaining('below the minimum floor'),
          }),
        }),
      }),
    });
  });

  it('#191 — reports ok when keeper balance is exactly at the configured floor', async () => {
    const controller = build({ balance: '5', minBalance: '5' });

    const body = await controller.check();

    expect(body.status).toBe('ok');
    expect(body.checks.stellar.status).toBe('ok');
  });

  it('#191 — uses the default 5 XLM floor when KEEPER_MIN_BALANCE_XLM is not configured', async () => {
    const controller = build({ balance: '1' });

    await expect(controller.check()).rejects.toMatchObject({
      response: expect.objectContaining({
        checks: expect.objectContaining({
          stellar: expect.objectContaining({ status: 'error' }),
        }),
      }),
    });
  });
});
