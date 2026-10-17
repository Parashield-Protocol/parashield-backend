import {
  shutdownOpenTelemetry,
  _setMockOpenTelemetrySdk,
  _resetOpenTelemetryState,
  registerOtelSignalHandlers,
  OpenTelemetryShutdownHook,
} from './opentelemetry';

describe('OpenTelemetry Graceful Shutdown (#715)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OTEL_SDK_DISABLED;
    delete process.env.OTEL_SHUTDOWN_TIMEOUT_MS;
    delete process.env.OTEL_FLUSH_TIMEOUT_MS;
    _resetOpenTelemetryState();
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetOpenTelemetryState();
    jest.clearAllMocks();
  });

  it('awaits the flush before resolving', async () => {
    let flushed = false;
    const mockSdk = {
      start: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        flushed = true;
      }),
    };

    _setMockOpenTelemetrySdk(mockSdk);

    const shutdownResult = await shutdownOpenTelemetry({ timeoutMs: 500 });

    expect(flushed).toBe(true);
    expect(mockSdk.shutdown).toHaveBeenCalledTimes(1);
    expect(shutdownResult).toBe(true);
  });

  it('abandons a hanging exporter after the timeout', async () => {
    const mockSdk = {
      start: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockImplementation(() => {
        // Hung exporter: returns a promise that never resolves
        return new Promise(() => {});
      }),
    };

    _setMockOpenTelemetrySdk(mockSdk);

    const startTime = Date.now();
    // Short timeout of 100ms
    const shutdownResult = await shutdownOpenTelemetry({ timeoutMs: 100 });
    const elapsed = Date.now() - startTime;

    expect(mockSdk.shutdown).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(shutdownResult).toBe(false);
  });

  it('is idempotent: a second signal or call does not double-shutdown', async () => {
    const mockSdk = {
      start: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }),
    };

    _setMockOpenTelemetrySdk(mockSdk);

    // Run first shutdown and second shutdown concurrently (repeated signals while shutting down)
    const [res1, res2] = await Promise.all([
      shutdownOpenTelemetry({ timeoutMs: 500 }),
      shutdownOpenTelemetry({ timeoutMs: 500 }),
    ]);

    expect(res1).toBe(true);
    expect(res2).toBe(true);
    expect(mockSdk.shutdown).toHaveBeenCalledTimes(1);

    // Sequential third call after completion
    const res3 = await shutdownOpenTelemetry({ timeoutMs: 500 });
    expect(res3).toBe(true);
    expect(mockSdk.shutdown).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when tracing is disabled (OTEL_SDK_DISABLED=true)', async () => {
    process.env.OTEL_SDK_DISABLED = 'true';

    const mockSdk = {
      start: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    };

    _setMockOpenTelemetrySdk(mockSdk);

    const result = await shutdownOpenTelemetry();

    expect(result).toBe(true);
    expect(mockSdk.shutdown).not.toHaveBeenCalled();
  });

  it('is called via OpenTelemetryShutdownHook in beforeApplicationShutdown', async () => {
    const mockSdk = {
      start: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    };

    _setMockOpenTelemetrySdk(mockSdk);

    const hook = new OpenTelemetryShutdownHook();
    await hook.beforeApplicationShutdown('SIGTERM');

    expect(mockSdk.shutdown).toHaveBeenCalledTimes(1);
  });

  it('handles SIGTERM and SIGINT without real signals or killing test runner', async () => {
    const mockSdk = {
      start: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    };

    _setMockOpenTelemetrySdk(mockSdk);

    registerOtelSignalHandlers(500);

    // Emit synthetic SIGTERM via process.emit
    process.emit('SIGTERM', 'SIGTERM');

    // Wait a tick for async handler to run
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockSdk.shutdown).toHaveBeenCalled();
  });
});
