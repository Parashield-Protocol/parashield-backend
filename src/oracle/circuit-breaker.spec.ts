import { ServiceUnavailableException } from '@nestjs/common';
import { CircuitBreaker } from './oracle.service';

/**
 * #842 — state-transition coverage for the CircuitBreaker used by OracleService.
 * Uses jest fake timers so resetTimeoutMs elapses without real waiting.
 */
describe('CircuitBreaker state transitions (#842)', () => {
  const NAME = 'test-service';
  const THRESHOLD = 3;
  const RESET_MS = 10_000;

  const networkError = () => new Error('socket hang up');
  const httpError = (status: number) =>
    Object.assign(new Error(`HTTP ${status}`), { response: { status } });

  const failingCall = (err: unknown = networkError()) => () => Promise.reject(err);
  const succeedingCall = () => () => Promise.resolve('ok');

  /** Run a call expected to fail and swallow the rejection. */
  const expectFailure = async (breaker: CircuitBreaker, err?: unknown) => {
    await expect(breaker.execute(failingCall(err))).rejects.toBeDefined();
  };

  let breaker: CircuitBreaker;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    breaker = new CircuitBreaker(NAME, THRESHOLD, RESET_MS);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts CLOSED', () => {
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('transitions CLOSED -> OPEN after failureThreshold consecutive failures', async () => {
    for (let i = 1; i < THRESHOLD; i++) {
      await expectFailure(breaker);
      expect(breaker.getState()).toBe('CLOSED');
    }

    await expectFailure(breaker);
    expect(breaker.getState()).toBe('OPEN');
  });

  it('fails fast without invoking fn while OPEN', async () => {
    for (let i = 0; i < THRESHOLD; i++) {
      await expectFailure(breaker);
    }

    const fn = jest.fn().mockResolvedValue('ok');
    await expect(breaker.execute(fn)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fn).not.toHaveBeenCalled();
  });

  it('resets the failure count on success so a later failure does not open the circuit', async () => {
    await expectFailure(breaker);
    await expectFailure(breaker);
    await breaker.execute(succeedingCall());

    await expectFailure(breaker);
    await expectFailure(breaker);
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('transitions OPEN -> HALF_OPEN once resetTimeoutMs has elapsed', async () => {
    for (let i = 0; i < THRESHOLD; i++) {
      await expectFailure(breaker);
    }
    expect(breaker.getState()).toBe('OPEN');

    jest.advanceTimersByTime(RESET_MS - 1);
    expect(breaker.getState()).toBe('OPEN');

    jest.advanceTimersByTime(1);
    expect(breaker.getState()).toBe('HALF_OPEN');
  });

  it('transitions HALF_OPEN -> CLOSED when the probe succeeds', async () => {
    for (let i = 0; i < THRESHOLD; i++) {
      await expectFailure(breaker);
    }
    jest.advanceTimersByTime(RESET_MS);

    await expect(breaker.execute(succeedingCall())).resolves.toBe('ok');
    expect(breaker.getState()).toBe('CLOSED');

    // Closed again: failures must once more count from zero up to the threshold.
    for (let i = 1; i < THRESHOLD; i++) {
      await expectFailure(breaker);
    }
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('transitions HALF_OPEN -> OPEN when the probe fails', async () => {
    for (let i = 0; i < THRESHOLD; i++) {
      await expectFailure(breaker);
    }
    jest.advanceTimersByTime(RESET_MS);
    expect(breaker.getState()).toBe('HALF_OPEN');

    await expectFailure(breaker);
    expect(breaker.getState()).toBe('OPEN');
  });

  it('restarts the reset timeout after a failed probe', async () => {
    for (let i = 0; i < THRESHOLD; i++) {
      await expectFailure(breaker);
    }
    jest.advanceTimersByTime(RESET_MS);
    await expectFailure(breaker);

    jest.advanceTimersByTime(RESET_MS - 1);
    expect(breaker.getState()).toBe('OPEN');

    jest.advanceTimersByTime(1);
    expect(breaker.getState()).toBe('HALF_OPEN');
  });

  it('does not count 4xx errors toward failureThreshold', async () => {
    for (let i = 0; i < THRESHOLD * 3; i++) {
      await expectFailure(breaker, httpError(400));
    }
    expect(breaker.getState()).toBe('CLOSED');

    // The circuit still opens on 5xx failures.
    for (let i = 0; i < THRESHOLD; i++) {
      await expectFailure(breaker, httpError(503));
    }
    expect(breaker.getState()).toBe('OPEN');
  });

  it('rejects concurrent requests while the HALF_OPEN probe is in flight', async () => {
    for (let i = 0; i < THRESHOLD; i++) {
      await expectFailure(breaker);
    }
    jest.advanceTimersByTime(RESET_MS);

    let resolveProbe!: (value: string) => void;
    const probe = breaker.execute(
      () => new Promise<string>((resolve) => (resolveProbe = resolve)),
    );

    const concurrentFn = jest.fn().mockResolvedValue('should not run');
    await expect(breaker.execute(concurrentFn)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(concurrentFn).not.toHaveBeenCalled();

    resolveProbe('probe-ok');
    await expect(probe).resolves.toBe('probe-ok');
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('releases the probe slot after a 4xx probe so the next request is allowed (#825)', async () => {
    for (let i = 0; i < THRESHOLD; i++) {
      await expectFailure(breaker);
    }
    jest.advanceTimersByTime(RESET_MS);

    await expectFailure(breaker, httpError(400));
    expect(breaker.getState()).toBe('HALF_OPEN');

    await expect(breaker.execute(succeedingCall())).resolves.toBe('ok');
    expect(breaker.getState()).toBe('CLOSED');
  });
});
