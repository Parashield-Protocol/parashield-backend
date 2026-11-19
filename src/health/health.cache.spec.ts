import { HealthController } from './health.controller';

describe('HealthController caching & stale-while-revalidate (#865)', () => {
  function createController() {
    const mockPrisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    const mockStellar = {
      getKeeperBalanceXlm: jest.fn().mockResolvedValue('50'),
      getNetworkStatus: jest.fn().mockResolvedValue({
        reachable: true,
        passphraseMatches: true,
        configuredNetwork: 'testnet',
      }),
    };
    const mockConfig = {
      get: jest.fn().mockReturnValue(undefined),
    };
    const mockRedis = {
      ping: jest.fn().mockResolvedValue('PONG'),
      info: jest.fn().mockResolvedValue('used_memory_human:1M\nused_memory_peak_human:2M\nmaxmemory_human:0B\nused_memory:1048576\nmaxmemory:0'),
      mget: jest.fn().mockResolvedValue([]),
    };

    const controller = new HealthController(
      mockPrisma as any,
      mockStellar as any,
      mockConfig as any,
      mockRedis as any,
    );

    // Avoid real outbound HTTP in unit test
    jest.spyOn(controller as any, 'executeHealthCheck').mockImplementation(async () => {
      const body = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'parashield-api',
        version: '0.1.0',
        commitSha: 'test',
        responseTimeMs: 5,
        uptimeMs: 1000,
        checks: {
          database: { status: 'ok' },
          stellar: { status: 'ok' },
          queue: { status: 'ok' },
          externalApis: { openMeteo: { status: 'ok' }, aviationStack: { status: 'ok' } },
        },
      } as any;
      (controller as any).healthResponseCache = { timestamp: Date.now(), body };
      return body;
    });

    return { controller };
  }

  it('serves cached response within 15s TTL without re-running probes', async () => {
    const { controller } = createController();
    const execSpy = jest.spyOn(controller as any, 'executeHealthCheck');

    await controller.check();
    await controller.check();

    expect(execSpy).toHaveBeenCalledTimes(1);
  });

  it('serves stale response immediately between 15s and 60s and triggers background refresh', async () => {
    const { controller } = createController();
    const execSpy = jest.spyOn(controller as any, 'executeHealthCheck');

    const first = await controller.check();
    // Age cache to 20s (past 15s fresh TTL, within 60s stale window)
    (controller as any).healthResponseCache.timestamp = Date.now() - 20_000;

    const second = await controller.check();
    expect(second).toBe(first);
    expect(execSpy).toHaveBeenCalledTimes(2);
  });
});
