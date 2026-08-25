import { OracleWorker } from './oracle.worker';
import { OracleReading, OracleService } from './oracle.service';
import { StellarService } from '../stellar/stellar.service';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { nativeToScVal } from '@stellar/stellar-sdk';

describe('OracleWorker', () => {
  const reading: OracleReading = {
    dataType: 'weather',
    key: 'rainfall:-0.0917,34.7679:2026-06',
    value: "100",
    confidence: 95,
    timestamp: 1,
    source: 'open-meteo',
  };

  let oracleService: jest.Mocked<
    Pick<
      OracleService,
      | 'fetchRainfallReading'
      | 'fetchFlightDelayReading'
      | 'persistReading'
      | 'claimForOnChainSubmission'
      | 'recordOnChainSubmission'
      | 'releaseOnChainClaim'
    >
  >;
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
      claimForOnChainSubmission: jest.fn().mockResolvedValue(true),
      recordOnChainSubmission: jest.fn().mockResolvedValue(undefined),
      releaseOnChainClaim: jest.fn().mockResolvedValue(undefined),
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

  describe('confidence gate and on-chain idempotency (#171, #172)', () => {
    const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

    function buildWorker() {
      return new OracleWorker(
        oracleService as unknown as OracleService,
        configService as unknown as ConfigService,
        stellarService as unknown as StellarService,
        prismaService as unknown as PrismaService,
      );
    }

    beforeEach(() => {
      configService.get.mockImplementation((key: string) =>
        key === 'ORACLE_VERIFIER_CONTRACT' ? contractId : undefined,
      );
      prismaService.policy.findMany.mockResolvedValue([
        { oracleKey: 'flight:KQ200:2026-06-27' },
      ]);
      stellarService.invokeContract.mockResolvedValue('tx-hash-1');
    });

    it('never persists or submits a NO_DATA reading', async () => {
      oracleService.fetchFlightDelayReading.mockResolvedValue({
        dataType: 'flight',
        key: 'flight:KQ200:2026-06-27',
        value: '0',
        confidence: 0,
        timestamp: 1,
        source: 'aviationstack',
        status: 'NO_DATA',
      });

      const worker = buildWorker();
      await worker.pollAndSubmit();

      expect(oracleService.persistReading).not.toHaveBeenCalled();
      expect(stellarService.invokeContract).not.toHaveBeenCalled();
      expect(worker.getMetrics().skipped).toBe(1);
    });

    it('honours a configured minimum confidence threshold', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'ORACLE_VERIFIER_CONTRACT') return contractId;
        if (key === 'ORACLE_MIN_CONFIDENCE') return '90';
        return undefined;
      });
      oracleService.fetchFlightDelayReading.mockResolvedValue({
        ...reading,
        key: 'flight:KQ200:2026-06-27',
        confidence: 80,
      });

      const worker = buildWorker();
      await worker.pollAndSubmit();

      expect(stellarService.invokeContract).not.toHaveBeenCalled();
      expect(worker.getMetrics().skipped).toBe(1);
    });

    it('submits once and records the tx hash when the claim is granted', async () => {
      oracleService.fetchFlightDelayReading.mockResolvedValue({
        ...reading,
        key: 'flight:KQ200:2026-06-27',
      });

      const worker = buildWorker();
      await worker.pollAndSubmit();

      expect(oracleService.claimForOnChainSubmission).toHaveBeenCalledTimes(1);
      expect(stellarService.invokeContract).toHaveBeenCalledTimes(1);
      expect(oracleService.recordOnChainSubmission).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'flight:KQ200:2026-06-27' }),
        'tx-hash-1',
      );
      expect(worker.getMetrics().submitted).toBe(1);
    });

    it('skips the contract call when another replica already claimed the bucket', async () => {
      oracleService.fetchFlightDelayReading.mockResolvedValue({
        ...reading,
        key: 'flight:KQ200:2026-06-27',
      });
      oracleService.claimForOnChainSubmission.mockResolvedValue(false);

      const worker = buildWorker();
      await worker.pollAndSubmit();

      expect(stellarService.invokeContract).not.toHaveBeenCalled();
      expect(worker.getMetrics().duplicates).toBe(1);
    });

    it('submits only once across two cron runs in the same bucket', async () => {
      oracleService.fetchFlightDelayReading.mockResolvedValue({
        ...reading,
        key: 'flight:KQ200:2026-06-27',
      });
      oracleService.claimForOnChainSubmission
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const worker = buildWorker();
      await worker.pollAndSubmit();
      await worker.pollAndSubmit();

      expect(stellarService.invokeContract).toHaveBeenCalledTimes(1);
      expect(worker.getMetrics()).toEqual(
        expect.objectContaining({ submitted: 1, duplicates: 1 }),
      );
    });

    it('releases the claim when the on-chain submission fails', async () => {
      oracleService.fetchFlightDelayReading.mockResolvedValue({
        ...reading,
        key: 'flight:KQ200:2026-06-27',
      });
      stellarService.invokeContract.mockRejectedValue(new Error('rpc down'));

      const worker = buildWorker();
      await worker.pollAndSubmit();

      expect(oracleService.releaseOnChainClaim).toHaveBeenCalledTimes(1);
      expect(oracleService.recordOnChainSubmission).not.toHaveBeenCalled();
    });

    // #272 — Both earlier oracle worker tests mocked configService.get to return ''
    // so ORACLE_VERIFIER_CONTRACT was always falsy and invokeContract was never reached.
    // The ScVal type tags and argument order passed to invokeContract were completely
    // untested — a wrong type tag or swapped argument would silently corrupt on-chain data.
    it('#272 — invokeContract receives correctly typed and ordered ScVal arguments', async () => {
      const submissionReading: OracleReading = {
        dataType:   'weather',
        key:        'flight:KQ200:2026-06-27',
        value:      '250',
        confidence: 92,
        timestamp:  1_700_000_000,
        source:     'aviationstack',
      };
      oracleService.fetchFlightDelayReading.mockResolvedValue(submissionReading);

      const worker = buildWorker();
      await worker.pollAndSubmit();

      expect(stellarService.invokeContract).toHaveBeenCalledWith(
        contractId,
        'submit_data',
        [
          nativeToScVal(submissionReading.dataType,            { type: 'symbol' }),
          nativeToScVal(submissionReading.key,                 { type: 'symbol' }),
          nativeToScVal(BigInt(submissionReading.value),       { type: 'i128' }),
          nativeToScVal(submissionReading.confidence,          { type: 'u32' }),
          nativeToScVal(BigInt(submissionReading.timestamp),   { type: 'u64' }),
        ],
      );
    });

    it('counts a reading that failed both fetch attempts as invalid', async () => {
      oracleService.fetchFlightDelayReading.mockRejectedValue(
        new Error('upstream value outside the plausible range'),
      );

      const worker = buildWorker();
      const poll = worker.pollAndSubmit();
      await jest.advanceTimersByTimeAsync(5_000);
      await poll;

      expect(stellarService.invokeContract).not.toHaveBeenCalled();
      expect(worker.getMetrics().invalid).toBe(1);
    });
  });

  describe('edge cases and error handling', () => {
    const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

    function buildWorker() {
      return new OracleWorker(
        oracleService as unknown as OracleService,
        configService as unknown as ConfigService,
        stellarService as unknown as StellarService,
        prismaService as unknown as PrismaService,
      );
    }

    beforeEach(() => {
      configService.get.mockImplementation((key: string) =>
        key === 'ORACLE_VERIFIER_CONTRACT' ? contractId : undefined,
      );
    });

    it('skips invalid rainfall key format', async () => {
      prismaService.policy.findMany.mockResolvedValue([
        { oracleKey: 'rainfall:invalid-format' },
      ]);

      const worker = buildWorker();
      await worker.pollAndSubmit();

      expect(oracleService.fetchRainfallReading).not.toHaveBeenCalled();
      expect(worker.getMetrics().invalid).toBe(0);
    });

    it('skips invalid flight key format', async () => {
      prismaService.policy.findMany.mockResolvedValue([
        { oracleKey: 'flight:invalid-format' },
      ]);

      const worker = buildWorker();
      await worker.pollAndSubmit();

      expect(oracleService.fetchFlightDelayReading).not.toHaveBeenCalled();
      expect(worker.getMetrics().invalid).toBe(0);
    });

    it('skips unsupported DeFi oracle keys', async () => {
      prismaService.policy.findMany.mockResolvedValue([
        { oracleKey: 'defi:some-key' },
      ]);

      const worker = buildWorker();
      await worker.pollAndSubmit();

      expect(oracleService.fetchRainfallReading).not.toHaveBeenCalled();
      expect(worker.getMetrics().invalid).toBe(0);
    });

    it('skips unknown oracle key types', async () => {
      prismaService.policy.findMany.mockResolvedValue([
        { oracleKey: 'unknown:some-key' },
      ]);

      const worker = buildWorker();
      await worker.pollAndSubmit();

      expect(oracleService.fetchRainfallReading).not.toHaveBeenCalled();
      expect(worker.getMetrics().invalid).toBe(0);
    });

    it('handles errors when fetching active policies from database', async () => {
      prismaService.policy.findMany.mockRejectedValue(new Error('db connection failed'));

      const worker = buildWorker();
      await worker.pollAndSubmit();

      expect(worker.getMetrics()).toEqual({
        submitted: 0,
        skipped: 0,
        duplicates: 0,
        invalid: 0,
      });
    });

    it('uses fallback Kisumu coordinates when no policies are found', async () => {
      prismaService.policy.findMany.mockResolvedValue([]);
      oracleService.fetchRainfallReading.mockResolvedValue({
        dataType: 'weather',
        key: 'rainfall:-0.0917,34.7679:2026-06',
        value: '100',
        confidence: 95,
        timestamp: 1,
        source: 'open-meteo',
      });

      const worker = buildWorker();
      await worker.pollAndSubmit();

      expect(oracleService.fetchRainfallReading).toHaveBeenCalledWith(-0.0917, 34.7679, 2026, 6);
      expect(worker.getMetrics().submitted).toBe(1);
    });

    it('handles error when persisting reading', async () => {
      prismaService.policy.findMany.mockResolvedValue([
        { oracleKey: 'rainfall:1.2345,5.6789:2026-06' },
      ]);
      oracleService.fetchRainfallReading.mockResolvedValue({
        dataType: 'weather',
        key: 'rainfall:1.2345,5.6789:2026-06',
        value: '100',
        confidence: 95,
        timestamp: 1,
        source: 'open-meteo',
      });
      oracleService.persistReading.mockRejectedValue(new Error('db write failed'));

      const worker = buildWorker();
      await worker.pollAndSubmit();

      expect(stellarService.invokeContract).not.toHaveBeenCalled();
      expect(worker.getMetrics().invalid).toBe(0);
    });

    it('skips on-chain submission when reading has zero confidence', async () => {
      prismaService.policy.findMany.mockResolvedValue([
        { oracleKey: 'rainfall:1.2345,5.6789:2026-06' },
      ]);
      oracleService.fetchRainfallReading.mockResolvedValue({
        dataType: 'weather',
        key: 'rainfall:1.2345,5.6789:2026-06',
        value: '100',
        confidence: 0,
        timestamp: 1,
        source: 'open-meteo',
      });

      const worker = buildWorker();
      await worker.pollAndSubmit();

      expect(stellarService.invokeContract).not.toHaveBeenCalled();
      expect(worker.getMetrics().submitted).toBe(0);
    });

    it('skips on-chain submission when reading is from mock source', async () => {
      prismaService.policy.findMany.mockResolvedValue([
        { oracleKey: 'rainfall:1.2345,5.6789:2026-06' },
      ]);
      oracleService.fetchRainfallReading.mockResolvedValue({
        dataType: 'weather',
        key: 'rainfall:1.2345,5.6789:2026-06',
        value: '100',
        confidence: 95,
        timestamp: 1,
        source: 'mock',
      });

      const worker = buildWorker();
      await worker.pollAndSubmit();

      expect(stellarService.invokeContract).not.toHaveBeenCalled();
      expect(worker.getMetrics().submitted).toBe(0);
    });

    it('processes multiple keys concurrently', async () => {
      const keys = Array.from({ length: 5 }, (_, i) => `rainfall:1.${i},5.${i}:2026-06`);
      prismaService.policy.findMany.mockResolvedValue(
        keys.map((key) => ({ oracleKey: key }))
      );
      oracleService.fetchRainfallReading.mockResolvedValue({
        dataType: 'weather',
        key: 'rainfall:1.0,5.0:2026-06',
        value: '100',
        confidence: 95,
        timestamp: 1,
        source: 'open-meteo',
      });

      const worker = buildWorker();
      await worker.pollAndSubmit();

      expect(oracleService.fetchRainfallReading).toHaveBeenCalledTimes(5);
      expect(worker.getMetrics().submitted).toBe(5);
    });

    it('handles error when claiming on-chain submission slot', async () => {
      prismaService.policy.findMany.mockResolvedValue([
        { oracleKey: 'rainfall:1.2345,5.6789:2026-06' },
      ]);
      oracleService.fetchRainfallReading.mockResolvedValue({
        dataType: 'weather',
        key: 'rainfall:1.2345,5.6789:2026-06',
        value: '100',
        confidence: 95,
        timestamp: 1,
        source: 'open-meteo',
      });
      oracleService.claimForOnChainSubmission.mockRejectedValue(
        new Error('claim failed')
      );

      const worker = buildWorker();
      await worker.pollAndSubmit();

      expect(stellarService.invokeContract).not.toHaveBeenCalled();
      expect(worker.getMetrics().invalid).toBe(0);
    });
  });
});
