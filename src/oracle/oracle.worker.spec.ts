import { OracleWorker } from './oracle.worker';
import { OracleReading, OracleService } from './oracle.service';
import { StellarService } from '../stellar/stellar.service';
import { ConfigService } from '@nestjs/config';

describe('OracleWorker', () => {
  const reading: OracleReading = {
    dataType: 'weather',
    key: 'rainfall:-0.0917,34.7679:2026-06',
    value: 100n,
    confidence: 95,
    timestamp: 1,
    source: 'open-meteo',
  };

  let oracleService: jest.Mocked<Pick<OracleService, 'fetchRainfallReading' | 'persistReading'>>;
  let configService: jest.Mocked<Pick<ConfigService, 'get'>>;
  let stellarService: jest.Mocked<Pick<StellarService, 'invokeContract'>>;

  beforeEach(() => {
    jest.useFakeTimers();
    oracleService = {
      fetchRainfallReading: jest.fn(),
      persistReading: jest.fn().mockResolvedValue(undefined),
    };
    configService = {
      get: jest.fn().mockReturnValue(''),
    };
    stellarService = {
      invokeContract: jest.fn(),
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
    );

    const poll = worker.pollAndSubmit();
    await Promise.resolve();

    expect(oracleService.fetchRainfallReading).toHaveBeenCalledTimes(1);
    expect(oracleService.persistReading).not.toHaveBeenCalled();

    jest.advanceTimersByTime(4_999);
    await Promise.resolve();
    expect(oracleService.fetchRainfallReading).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    await poll;

    expect(oracleService.fetchRainfallReading).toHaveBeenCalledTimes(2);
    expect(oracleService.persistReading).toHaveBeenCalledTimes(1);
    expect(oracleService.persistReading).toHaveBeenCalledWith(reading);
  });
});
