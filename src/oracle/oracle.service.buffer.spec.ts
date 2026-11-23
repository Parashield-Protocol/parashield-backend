import { ConfigService } from "@nestjs/config";
import { ServiceUnavailableException } from "@nestjs/common";
import { OracleService } from "./oracle.service";

// #844 — Buffer/flush lifecycle and backpressure for OracleService batching.
describe("OracleService buffer flush lifecycle (#844)", () => {
  let prisma: {
    $transaction: jest.Mock;
    oracleReading: { upsert: jest.Mock };
  };

  function makeService(
    overrides: { batchSize?: string; flushIntervalMs?: string; maxBufferSize?: string } = {},
  ): OracleService {
    const env: Record<string, string | undefined> = {
      ORACLE_BATCH_SIZE: overrides.batchSize ?? "3",
      ORACLE_FLUSH_INTERVAL_MS: overrides.flushIntervalMs ?? "500",
      ORACLE_BUFFER_MAX_SIZE: overrides.maxBufferSize ?? "100",
    };
    const config = { get: jest.fn((key: string) => env[key]) };
    return new OracleService(config as unknown as ConfigService, prisma as any, {} as any, {} as any);
  }

  function createReading(key: string, value = "10000000"): any {
    return {
      dataType: "weather",
      key,
      value,
      confidence: 95,
      timestamp: Math.floor(Date.now() / 1000) - 100,
      source: "open-meteo",
      status: "OK",
    };
  }

  /** Keys passed to prisma.oracleReading.upsert, in call order. */
  function upsertedKeys(): string[] {
    return prisma.oracleReading.upsert.mock.calls.map(
      (call) => call[0].where.key_source_bucket.key as string,
    );
  }

  beforeEach(() => {
    jest.useFakeTimers();
    prisma = {
      // Mirror Prisma's interactive batch: resolves only when every op resolves.
      $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
      oracleReading: {
        upsert: jest.fn().mockResolvedValue({ id: "row" }),
      },
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("buffers readings without writing until batchSize is reached", async () => {
    const service = makeService({ batchSize: "3" });

    const p1 = service.persistReading(createReading("key-1"));
    const p2 = service.persistReading(createReading("key-2"));
    expect(service.getBufferSize()).toBe(2);
    expect(prisma.$transaction).not.toHaveBeenCalled();

    const p3 = service.persistReading(createReading("key-3"));
    await Promise.all([p1, p2, p3]);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(3);
    expect(service.getBufferSize()).toBe(0);
  });

  it("flushes the buffer on the timer after flushIntervalMs, without resetting it per reading", async () => {
    const service = makeService({ batchSize: "10", flushIntervalMs: "500" });

    const p1 = service.persistReading(createReading("timer-1"));
    jest.advanceTimersByTime(300);
    const p2 = service.persistReading(createReading("timer-2"));

    jest.advanceTimersByTime(199);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(service.getBufferSize()).toBe(2);

    // The timer was armed by the first reading, so it fires at t=500 not t=800.
    jest.advanceTimersByTime(1);
    await Promise.all([p1, p2]);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2);
    expect(service.getBufferSize()).toBe(0);
  });

  it("applies backpressure once the buffer reaches maxBufferSize", async () => {
    // batchSize above maxBufferSize so the buffer fills instead of flushing.
    const service = makeService({ batchSize: "1000", flushIntervalMs: "60000", maxBufferSize: "10" });

    const pending: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      pending.push(service.persistReading(createReading(`bp-${i}`)));
    }
    expect(service.getBufferSize()).toBe(10);

    await expect(service.persistReading(createReading("bp-overflow"))).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(service.getBufferSize()).toBe(10);
    expect(prisma.$transaction).not.toHaveBeenCalled();

    // Draining the buffer frees capacity again.
    await service.flushBuffer();
    await Promise.all(pending);
    expect(service.getBufferSize()).toBe(0);

    const accepted = service.persistReading(createReading("bp-after-drain"));
    expect(service.getBufferSize()).toBe(1);
    await service.flushBuffer();
    await accepted;
  });

  it("falls back to individual upserts when the batch fails, resolving every reading", async () => {
    const service = makeService({ batchSize: "3" });
    prisma.$transaction.mockRejectedValueOnce(new Error("batch boom"));

    const results = await Promise.allSettled([
      service.persistReading(createReading("fb-1")),
      service.persistReading(createReading("fb-2")),
      service.persistReading(createReading("fb-3")),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // 3 upserts built for the failed batch, then 3 individual upserts.
    expect(upsertedKeys()).toEqual(["fb-1", "fb-2", "fb-3", "fb-1", "fb-2", "fb-3"]);
  });

  it("isolates a single bad row during fallback: only its promise rejects", async () => {
    const service = makeService({ batchSize: "3" });
    const badError = new Error("constraint violated for bad row");
    prisma.oracleReading.upsert.mockImplementation((args: any) => {
      if (args.where.key_source_bucket.key === "bad") return Promise.reject(badError);
      return Promise.resolve({ id: "row" });
    });

    const good1 = service.persistReading(createReading("good-1"));
    // Attach the rejection handler immediately to avoid an unhandled-rejection window.
    const bad = service.persistReading(createReading("bad")).catch((err) => err);
    const good2 = service.persistReading(createReading("good-2"));

    await expect(good1).resolves.toBeUndefined();
    await expect(bad).resolves.toBe(badError);
    await expect(good2).resolves.toBeUndefined();
    expect(service.getBufferSize()).toBe(0);
  });

  it("onApplicationShutdown flushes remaining buffered readings and cancels the timer", async () => {
    const service = makeService({ batchSize: "10", flushIntervalMs: "60000" });

    const p1 = service.persistReading(createReading("shutdown-1"));
    const p2 = service.persistReading(createReading("shutdown-2"));
    expect(prisma.$transaction).not.toHaveBeenCalled();

    await service.onApplicationShutdown("SIGTERM");
    await expect(Promise.all([p1, p2])).resolves.toBeDefined();

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2);
    expect(service.getBufferSize()).toBe(0);

    // The pending timer was cleared, so no second flush happens later.
    jest.advanceTimersByTime(60000);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("concurrent flushBuffer calls do not double-process readings", async () => {
    const service = makeService({ batchSize: "2", flushIntervalMs: "60000" });

    // Hold the first batch open so the second flush attempts overlap it.
    let releaseFirstBatch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    });
    prisma.$transaction.mockImplementationOnce(async (ops: Promise<unknown>[]) => {
      await gate;
      return Promise.all(ops);
    });

    const p1 = service.persistReading(createReading("cc-1"));
    const p2 = service.persistReading(createReading("cc-2"));
    // Buffer reaches batchSize again while the first flush is still in flight.
    const p3 = service.persistReading(createReading("cc-3"));
    const p4 = service.persistReading(createReading("cc-4"));

    await Promise.all([service.flushBuffer(), service.flushBuffer()]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    releaseFirstBatch();
    await Promise.all([p1, p2, p3, p4]);

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    const keys = upsertedKeys().sort();
    expect(keys).toEqual(["cc-1", "cc-2", "cc-3", "cc-4"]);
    expect(service.getBufferSize()).toBe(0);
  });
});
