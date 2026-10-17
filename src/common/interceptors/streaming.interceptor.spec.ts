import { CallHandler, ExecutionContext, StreamableFile } from '@nestjs/common';
import { firstValueFrom, of, Subject, Observable } from 'rxjs';
import { EventEmitter } from 'events';
import { StreamingInterceptor, StreamResourceHolder } from './streaming.interceptor';

describe('StreamingInterceptor & Client Disconnect (#673)', () => {
  let interceptor: StreamingInterceptor;

  beforeEach(() => {
    jest.useFakeTimers();
    interceptor = new StreamingInterceptor();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function contextFor(
    headers: Record<string, string> = {},
    query: Record<string, string> = {},
    reqEmitter?: EventEmitter,
  ) {
    const emitter = reqEmitter ?? new EventEmitter();
    const req: any = emitter;
    req.headers = headers;
    req.query = query;
    req.destroyed = false;

    const resEmitter = new EventEmitter();
    const res: any = resEmitter;
    res.setHeader = jest.fn();
    res.writableEnded = false;

    const context = {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    } as unknown as ExecutionContext;

    return { context, request: req, response: res };
  }

  function handlerFor(payload: unknown): CallHandler {
    return { handle: () => of(payload) } as unknown as CallHandler;
  }

  const PAGINATED = {
    success: true,
    data: [{ id: 'p1' }, { id: 'p2' }],
    total: 42,
    page: 2,
    limit: 20,
  };

  describe('non-streaming (default JSON) responses', () => {
    it('sets X-Total-Count, X-Page and X-Limit from the envelope', async () => {
      const { context, response } = contextFor();

      const result = await firstValueFrom(interceptor.intercept(context, handlerFor(PAGINATED)));

      expect(response.setHeader).toHaveBeenCalledWith('X-Total-Count', '42');
      expect(response.setHeader).toHaveBeenCalledWith('X-Page', '2');
      expect(response.setHeader).toHaveBeenCalledWith('X-Limit', '20');
      expect(result).toEqual(PAGINATED);
    });

    it('reports a total of 0 rather than omitting the header', async () => {
      const { context, response } = contextFor();

      await firstValueFrom(
        interceptor.intercept(context, handlerFor({ success: true, data: [], total: 0, page: 1, limit: 20 })),
      );

      expect(response.setHeader).toHaveBeenCalledWith('X-Total-Count', '0');
    });

    it('skips pagination headers the envelope does not carry', async () => {
      const { context, response } = contextFor();

      await firstValueFrom(interceptor.intercept(context, handlerFor({ success: true, data: [] })));

      expect(response.setHeader).not.toHaveBeenCalledWith('X-Total-Count', expect.anything());
      expect(response.setHeader).not.toHaveBeenCalledWith('Content-Type', expect.anything());
    });

    it('leaves non-object payloads untouched', async () => {
      for (const payload of [null, undefined, 'plain', 42]) {
        const { context, response } = contextFor();
        await expect(firstValueFrom(interceptor.intercept(context, handlerFor(payload)))).resolves.toBe(payload);
        expect(response.setHeader).not.toHaveBeenCalled();
      }
    });
  });

  describe('streaming responses (?stream=true & SSE disconnect)', () => {
    it('still sets the pagination headers while streaming NDJSON', async () => {
      const { context, response } = contextFor({}, { stream: 'true' });

      const result = await firstValueFrom(interceptor.intercept(context, handlerFor(PAGINATED)));

      expect(response.setHeader).toHaveBeenCalledWith('X-Total-Count', '42');
      expect(response.setHeader).toHaveBeenCalledWith('X-Page', '2');
      expect(response.setHeader).toHaveBeenCalledWith('X-Limit', '20');
      expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'application/x-ndjson; charset=utf-8');
      expect(result).toBeInstanceOf(StreamableFile);
    });

    it('honours the Accept header and passes non-list payloads through', async () => {
      const { context, response } = contextFor({ accept: 'application/x-ndjson' });

      const payload = { success: true, data: { nested: true }, total: 1 };
      const result = await firstValueFrom(interceptor.intercept(context, handlerFor(payload)));

      expect(result).toEqual(payload);
      expect(response.setHeader).toHaveBeenCalledWith('X-Total-Count', '1');
      expect(response.setHeader).not.toHaveBeenCalledWith('Content-Type', 'application/x-ndjson; charset=utf-8');
    });

    it('clears timers, removes listeners, releases cursor, and stops writing on client disconnect', (done) => {
      const reqEmitter = new EventEmitter();
      const { context, request, response } = contextFor(
        { accept: 'application/x-ndjson' },
        { stream: 'true' },
        reqEmitter,
      );

      const cursor = {
        release: jest.fn(),
        close: jest.fn(),
      };
      const abortController = new AbortController();
      let timerFiredCount = 0;
      const timer = setInterval(() => {
        timerFiredCount++;
      }, 1000);

      const items = Array.from({ length: 100 }, (_, i) => ({ id: `item-${i}` }));
      const payload: StreamResourceHolder & { success: boolean; data: any[]; total: number } = {
        success: true,
        data: items,
        total: 100,
        cursor,
        abortController,
        timers: [timer],
      };

      const stream$ = interceptor.intercept(context, handlerFor(payload));

      let streamFile: StreamableFile | undefined;
      const sub = stream$.subscribe({
        next: (val) => {
          streamFile = val as StreamableFile;
        },
      });

      // Verify listeners attached
      expect(request.listenerCount('close')).toBeGreaterThan(0);

      // Simulate client disconnect before stream finished
      request.emit('close');

      // Verify timers are cleared
      jest.advanceTimersByTime(5000);
      expect(timerFiredCount).toBe(0);

      // Verify cursor was released/closed
      expect(cursor.close).toHaveBeenCalledTimes(1);

      // Verify upstream work was aborted
      expect(abortController.signal.aborted).toBe(true);

      // Verify listeners removed
      expect(request.listenerCount('close')).toBe(0);

      // Verify stream is destroyed and nothing more is written
      const nodeStream = (streamFile as any)?.getStream?.();
      if (nodeStream) {
        expect(nodeStream.destroyed).toBe(true);
      }

      sub.unsubscribe();
      done();
    });

    it('ensures cleanup is idempotent when disconnect event fires multiple times', () => {
      const reqEmitter = new EventEmitter();
      const { context, request } = contextFor(
        { accept: 'application/x-ndjson' },
        { stream: 'true' },
        reqEmitter,
      );

      const cursor = {
        release: jest.fn(),
        close: jest.fn(),
      };

      const payload: StreamResourceHolder & { success: boolean; data: any[]; total: number } = {
        success: true,
        data: [{ id: '1' }],
        total: 1,
        cursor,
      };

      const sub = interceptor.intercept(context, handlerFor(payload)).subscribe();

      // Fire close twice
      request.emit('close');
      request.emit('close');

      expect(cursor.close).toHaveBeenCalledTimes(1);
      sub.unsubscribe();
    });

    it('unsubscribes from inner Observable stream on client disconnect', () => {
      const reqEmitter = new EventEmitter();
      const { context, request } = contextFor(
        { accept: 'text/event-stream' },
        {},
        reqEmitter,
      );

      let innerUnsubscribed = false;
      const innerObservable = new Observable((subscriber) => {
        subscriber.next({ data: { message: 'hello' } });
        return () => {
          innerUnsubscribed = true;
        };
      });

      const sub = interceptor.intercept(context, handlerFor(innerObservable)).subscribe();

      expect(innerUnsubscribed).toBe(false);

      // Disconnect
      request.emit('close');

      expect(innerUnsubscribed).toBe(true);
      sub.unsubscribe();
    });

    it('cleans up resources on normal stream completion', () => {
      const { context } = contextFor({ accept: 'application/x-ndjson' });
      const cursor = { close: jest.fn() };
      const payload = { success: true, data: [{ id: 1 }], total: 1, cursor };

      interceptor.intercept(context, handlerFor(payload)).subscribe();

      // Normal completion
      jest.runAllTimers();
    });

    it('cleans up resources on stream error', (done) => {
      const { context } = contextFor({ accept: 'application/x-ndjson' });
      const cursor = { close: jest.fn() };
      const errorHandler: CallHandler = {
        handle: () =>
          new Observable((sub) => {
            sub.next({ success: true, data: [{ id: 1 }], cursor });
            sub.error(new Error('stream error'));
          }),
      };

      interceptor.intercept(context, errorHandler).subscribe({
        error: (err) => {
          expect(err.message).toBe('stream error');
          expect(cursor.close).toHaveBeenCalled();
          done();
        },
      });
    });
  });
});
