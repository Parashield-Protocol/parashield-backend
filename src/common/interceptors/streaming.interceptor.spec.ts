import { CallHandler, ExecutionContext, StreamableFile } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { StreamingInterceptor } from './streaming.interceptor';

describe('StreamingInterceptor', () => {
  const interceptor = new StreamingInterceptor();

  function contextFor(headers: Record<string, string> = {}, query: Record<string, string> = {}) {
    const response = { setHeader: jest.fn() };
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ headers, query }),
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
    return { context, response };
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

  describe('streaming responses (?stream=true)', () => {
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
  });
});
