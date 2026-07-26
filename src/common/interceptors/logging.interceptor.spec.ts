import { of, throwError } from 'rxjs';
import { LoggingInterceptor } from './logging.interceptor';

describe('LoggingInterceptor', () => {
  let interceptor: LoggingInterceptor;
  let logger: { log: jest.Mock; warn: jest.Mock };

  function mockContext(method: string, url: string, statusCode: number) {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ method, url }),
        getResponse: () => ({ statusCode }),
      }),
    } as any;
  }

  beforeEach(() => {
    interceptor = new LoggingInterceptor();
    logger = {
      log: jest.fn(),
      warn: jest.fn(),
    };
    (interceptor as any).logger = logger;
  });

  it('logs incoming request and successful response with duration', (done) => {
    const context = mockContext('GET', '/health', 200);
    const next = { handle: () => of('response') };

    interceptor.intercept(context, next).subscribe({
      complete: () => {
        expect(logger.log).toHaveBeenCalledWith('→ GET /health');
        expect(logger.log).toHaveBeenCalledWith(
          expect.stringMatching(/^← GET \/health 200 — \d+ms$/),
        );
        expect(logger.warn).not.toHaveBeenCalled();
        done();
      },
    });
  });

  it('logs error response with warn level and inferred status', (done) => {
    const context = mockContext('POST', '/api/v1/circles', 500);
    const error = Object.assign(new Error('Internal Server Error'), { status: 502 });
    const next = { handle: () => throwError(() => error) };

    interceptor.intercept(context, next).subscribe({
      error: () => {
        expect(logger.log).toHaveBeenCalledWith('→ POST /api/v1/circles');
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringMatching(/^← POST \/api\/v1\/circles 502 — \d+ms \(error\)$/),
        );
        done();
      },
    });
  });

  it('defaults to 500 when error has no status property', (done) => {
    const context = mockContext('DELETE', '/resource', 500);
    const error = new Error('unexpected');
    const next = { handle: () => throwError(() => error) };

    interceptor.intercept(context, next).subscribe({
      error: () => {
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringMatching(/^← DELETE \/resource 500 — \d+ms \(error\)$/),
        );
        done();
      },
    });
  });

  it('handles non-Error thrown values', (done) => {
    const context = mockContext('PUT', '/data', 500);
    const next = { handle: () => throwError(() => 'string error') };

    interceptor.intercept(context, next).subscribe({
      error: () => {
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringMatching(/^← PUT \/data 500 — \d+ms \(error\)$/),
        );
        done();
      },
    });
  });

  it('records duration as a positive number', (done) => {
    const context = mockContext('GET', '/fast', 200);
    const next = { handle: () => of('fast') };

    interceptor.intercept(context, next).subscribe({
      complete: () => {
        const call = logger.log.mock.calls.find((c: string[]) =>
          c[0].startsWith('←'),
        );
        const duration = parseInt((call?.[0] as string).match(/(\d+)ms/)?.[1] ?? '', 10);
        expect(duration).toBeGreaterThanOrEqual(0);
        done();
      },
    });
  });
});
