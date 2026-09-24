import { HttpException } from '@nestjs/common';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const KEEPER_ADDRESS = 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBKQTRB7KXQZ';

  function build(overrides?: {
    balance?: string;
    dbFails?: boolean;
    rpcFails?: boolean;
    network?: { status?: string; passphrase?: string; fails?: boolean };
    minBalance?: string;
    poolActive?: number;
    connectionLimit?: string;
    poolWarnPercent?: string;
  }) {
    const prisma = {
      $queryRaw: overrides?.dbFails
        ? jest.fn().mockRejectedValue(new Error('connection refused'))
        : jest.fn((strings: TemplateStringsArray) => {
            // Route pg_stat_activity (connection pool) queries to a shape
            // with `active` set from the override; every other query (the
            // initial SELECT 1, throughput, replication) gets the default
            // single-row placeholder — none of them read `state`/`count`.
            if (strings.join('').includes('pg_stat_activity')) {
              return Promise.resolve([
                { state: 'active', count: overrides?.poolActive ?? 0 },
                { state: 'idle', count: 0 },
              ]);
            }
            return Promise.resolve([{ '?column?': 1 }]);
          }),
    };
    const stellar = {
      keeperKeypair: { publicKey: () => KEEPER_ADDRESS },
      getAccountBalance: overrides?.rpcFails
        ? jest.fn().mockRejectedValue(new Error('RPC unreachable'))
        : jest.fn().mockResolvedValue(overrides?.balance ?? '100.0000000'),
      checkRpcConnectivity: jest.fn().mockResolvedValue({ latencyMs: 10, ledger: 1 }),
      checkNetworkStatus: overrides?.network?.fails
        ? jest.fn().mockRejectedValue(new Error('getHealth timed out'))
        : jest.fn().mockImplementation(async () => {
            const rpcHealth = overrides?.network?.status ?? 'healthy';
            const passphraseMatches = overrides?.network?.passphrase === undefined;
            return {
              healthy: rpcHealth === 'healthy' && passphraseMatches,
              rpcHealth,
              protocolVersion: 22,
              passphraseMatches,
            };
          }),
    };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'KEEPER_MIN_BALANCE_XLM') return overrides?.minBalance;
        if (key === 'DATABASE_CONNECTION_LIMIT') return overrides?.connectionLimit;
        if (key === 'DB_POOL_EXHAUSTION_WARN_PERCENT') return overrides?.poolWarnPercent;
        return undefined;
      }),
    };
    const redis = {
      ping: jest.fn().mockResolvedValue('PONG'),
      llen: jest.fn().mockResolvedValue(0),
      // Resolve every requested key with a fresh timestamp so worker
      // heartbeats read as 'ok' rather than 'stale' by default.
      mget: jest.fn((...keys: string[]) => Promise.resolve(keys.map(() => new Date().toISOString()))),
      info: jest.fn().mockResolvedValue(''),
    };

    return new HealthController(prisma as any, stellar as any, config as any, redis as any);
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

  // #471 — connection pool exhaustion monitoring
  describe('connection pool exhaustion (#471)', () => {
    it('reports utilization and exhausted:false when active connections are well below the configured max', async () => {
      const controller = build({ poolActive: 2, connectionLimit: '10' });

      const body = await controller.check();

      expect(body.status).toBe('ok');
      expect(body.checks.database.pool).toMatchObject({
        active: 2,
        max: 10,
        utilizationPercent: 20,
        exhausted: false,
      });
    });

    it('reports degraded database status once utilization meets the exhaustion warning threshold', async () => {
      const controller = build({ poolActive: 9, connectionLimit: '10', poolWarnPercent: '90' });

      await expect(controller.check()).rejects.toThrow(HttpException);
      await expect(controller.check()).rejects.toMatchObject({
        response: expect.objectContaining({
          checks: expect.objectContaining({
            database: expect.objectContaining({
              status: 'error',
              pool: expect.objectContaining({ active: 9, max: 10, utilizationPercent: 90, exhausted: true }),
              error: expect.stringContaining('exhaustion warning threshold'),
            }),
          }),
        }),
      });
    });

    it('stays ok when utilization is just below a custom warning threshold', async () => {
      const controller = build({ poolActive: 7, connectionLimit: '10', poolWarnPercent: '80' });

      const body = await controller.check();

      expect(body.checks.database.pool).toMatchObject({ utilizationPercent: 70, exhausted: false });
    });

    it('uses the default 10-connection max and 90% threshold when not configured', async () => {
      const controller = build({ poolActive: 9 });

      await expect(controller.check()).rejects.toMatchObject({
        response: expect.objectContaining({
          checks: expect.objectContaining({
            database: expect.objectContaining({
              pool: expect.objectContaining({ max: 10, utilizationPercent: 90, exhausted: true }),
            }),
          }),
        }),
      });
    });
  });

  // #474 — Stellar network status
  describe('Stellar network status (#474)', () => {
    it('reports network ok when the RPC is healthy and on the configured network', async () => {
      const body = await build({ balance: '50' }).check();

      expect(body.checks.stellar.network).toMatchObject({
        status: 'ok',
        rpcHealth: 'healthy',
        passphraseMatches: true,
      });
    });

    it('reports degraded when the RPC reports the network is not healthy', async () => {
      const controller = build({ balance: '50', network: { status: 'unhealthy' } });

      await expect(controller.check()).rejects.toMatchObject({
        response: expect.objectContaining({
          checks: expect.objectContaining({
            stellar: expect.objectContaining({
              status: 'error',
              network: expect.objectContaining({ status: 'error', rpcHealth: 'unhealthy' }),
              error: expect.stringContaining('not operational'),
            }),
          }),
        }),
      });
    });

    it('reports degraded when the RPC serves a different network than configured', async () => {
      const controller = build({ balance: '50', network: { passphrase: 'other' } });

      await expect(controller.check()).rejects.toMatchObject({
        response: expect.objectContaining({
          checks: expect.objectContaining({
            stellar: expect.objectContaining({
              status: 'error',
              network: expect.objectContaining({ passphraseMatches: false }),
              error: expect.stringContaining('different network'),
            }),
          }),
        }),
      });
    });

    it('reports degraded when the network status probe fails', async () => {
      const controller = build({ balance: '50', network: { fails: true } });

      await expect(controller.check()).rejects.toMatchObject({
        response: expect.objectContaining({
          checks: expect.objectContaining({
            stellar: expect.objectContaining({
              status: 'error',
              network: { status: 'error' },
              error: expect.stringContaining('network status check failed'),
            }),
          }),
        }),
      });
    });
  });
});
