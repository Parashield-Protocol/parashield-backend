import { OracleWorker } from './oracle.worker';
import { OracleReading, OracleService } from './oracle.service';
import { StellarService } from '../stellar/stellar.service';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

describe('OracleWorker', () => {
  const reading: OracleReading = {
    dataType: 'weather',
    key: 'rainfall:-0.0917,34.7679:2026-06',
    value: "100",
    confidence: 95,
    timestamp: 1,
    source: 'open-meteo',
  };

  let oracleService: jest.Mocked<Pick<OracleService, 'fetchRainfallReading' | 'fetchFlightDelayReading' | 'persistReading'>>;
  let configService: jest.Mocked<Pick<ConfigService, 'get'>>;
  let stellarService: jest.Mocked<Pick<StellarService, 'invokeContract'>>;
  let prismaService: jest.Mocked<any>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-27T00:00:00Z'));

    oracleService = {
      fetchRainfallReading: jest.fn(),
      fetchFlightDelayReading: jest.fn(),
      persistReading: jest.fn().mockResolvedValue(undefined),
    };
    configService = {
      get: jest.fn().mockReturnValue(''),
    };
    stellarService = {
      invokeContract: jest.fn(),
    };
    prismaService = {
      policy: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('waits before retrying and persists the successful reading only once', async () => {
    oracleService.fetchRainfallReading
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce(reading);

    const worker = new OracleWorker(
      oracleService as unknown as OracleService,
      configService as unknown as ConfigService,
      stellarService as unknown as StellarService,
      prismaService as unknown as PrismaService,
    );

    const poll = worker.pollAndSubmit();
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    expect(oracleService.fetchRainfallReading).toHaveBeenCalledTimes(1);
    expect(oracleService.persistReading).not.toHaveBeenCalled();

    jest.advanceTimersByTime(4_999);
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    expect(oracleService.fetchRainfallReading).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    await poll;

    expect(oracleService.fetchRainfallReading).toHaveBeenCalledTimes(2);
    expect(oracleService.persistReading).toHaveBeenCalledTimes(1);
    expect(oracleService.persistReading).toHaveBeenCalledWith(reading);
  });

  it('queries active policies and processes rainfall and flight keys', async () => {
    prismaService.policy.findMany.mockResolvedValue([
      { oracleKey: 'rainfall:1.2345,5.6789:2026-06' },
      { oracleKey: 'flight:KQ200:2026-06-27' },
      { oracleKey: 'defi:some-defi-key' }, // should be skipped with log
      { oracleKey: 'flight:KQ200:2026-06-27' }, // duplicate, should be deduplicated
    ]);

    const rainReading: OracleReading = {
      dataType: 'weather',
      key: 'rainfall:1.2345,5.6789:2026-06',
      value: "200",
      confidence: 90,
      timestamp: 1,
      source: 'open-meteo',
    };

    const flightReading: OracleReading = {
      dataType: 'flight',
      key: 'flight:KQ200:2026-06-27',
      value: "15",
      confidence: 95,
      timestamp: 1,
      source: 'aviationstack',
    };

    oracleService.fetchRainfallReading.mockResolvedValue(rainReading);
    oracleService.fetchFlightDelayReading.mockResolvedValue(flightReading);

    const worker = new OracleWorker(
      oracleService as unknown as OracleService,
      configService as unknown as ConfigService,
      stellarService as unknown as StellarService,
      prismaService as unknown as PrismaService,
    );

    await worker.pollAndSubmit();

    expect(prismaService.policy.findMany).toHaveBeenCalledWith({
      where: { status: 'ACTIVE' },
      select: { oracleKey: true },
    });

    expect(oracleService.fetchRainfallReading).toHaveBeenCalledTimes(1);
    expect(oracleService.fetchRainfallReading).toHaveBeenCalledWith(1.2345, 5.6789, 2026, 6);

    expect(oracleService.fetchFlightDelayReading).toHaveBeenCalledTimes(1);
    expect(oracleService.fetchFlightDelayReading).toHaveBeenCalledWith('KQ200', '2026-06-27');

    expect(oracleService.persistReading).toHaveBeenCalledTimes(2);
    expect(oracleService.persistReading).toHaveBeenNthCalledWith(1, rainReading);
    expect(oracleService.persistReading).toHaveBeenNthCalledWith(2, flightReading);
  });
});
