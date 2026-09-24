import { EventEmitter } from 'events';
import { IdempotencyMiddleware } from './idempotency.middleware';

// Minimal in-memory stand-in for the ioredis calls the middleware makes.
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    eval: jest.fn(async (_script: string, _n: number, key: string, token: string) => {
      if (store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
  };
}

function fakeRes() {
  const res = new EventEmitter() as any;
  res.statusCode = 200;
  res.headersSent = false;
  res.headers = {} as Record<string, string>;
  res.setHeader = jest.fn((k: string, v: string) => { res.headers[k] = v; });
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: unknown) => {
    res.body = body;
    res.headersSent = true;
    setImmediate(() => res.emit('finish'));
    return res;
  });
  return res;
}

const req = (key = 'abc') => ({ method: 'POST', path: '/api/v1/policies', headers: { 'idempotency-key': key } }) as any;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('IdempotencyMiddleware', () => {
  it('#484 — runs the handler once for concurrent requests with the same key and replays to the other', async () => {
    const redis = fakeRedis();
    const mw = new IdempotencyMiddleware(redis as any);
    let executions = 0;

    const handler = (res: any) => async () => {
      executions++;
      await tick(250); // simulate slow handler so the second request must wait
      res.status(201).json({ id: 'policy-1' });
    };

    const res1 = fakeRes();
    const res2 = fakeRes();
    mw.use(req(), res1, handler(res1));
    mw.use(req(), res2, handler(res2));

    await tick(700);

    expect(executions).toBe(1);
    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);
    expect(res2.body).toEqual({ id: 'policy-1' });
    expect(res2.headers['X-Idempotent-Replayed']).toBe('true');
    expect(redis.store.has('idempotency:POST:/api/v1/policies:abc:lock')).toBe(false);
  });

  it('lets a waiting request run the handler itself when the first one fails (errors are not cached)', async () => {
    const redis = fakeRedis();
    const mw = new IdempotencyMiddleware(redis as any);
    let executions = 0;

    const res1 = fakeRes();
    const res2 = fakeRes();
    mw.use(req(), res1, async () => {
      executions++;
      await tick(150);
      res1.status(500).json({ error: 'boom' });
    });
    mw.use(req(), res2, async () => {
      executions++;
      res2.status(201).json({ id: 'policy-2' });
    });

    await tick(600);

    expect(executions).toBe(2);
    expect(res1.statusCode).toBe(500);
    expect(res2.statusCode).toBe(201);
    expect(res2.headers['X-Idempotent-Replayed']).toBeUndefined();
  });

  it('replays a cached response without running the handler', async () => {
    const redis = fakeRedis();
    redis.store.set('idempotency:POST:/api/v1/policies:abc', JSON.stringify({ status: 201, body: { id: 'x' } }));
    const mw = new IdempotencyMiddleware(redis as any);
    const next = jest.fn();
    const res = fakeRes();

    mw.use(req(), res, next);
    await tick(10);

    expect(next).not.toHaveBeenCalled();
    expect(res.body).toEqual({ id: 'x' });
  });

  it('fails open when Redis is unavailable', async () => {
    const redis = fakeRedis();
    redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
    const mw = new IdempotencyMiddleware(redis as any);
    const next = jest.fn();

    mw.use(req(), fakeRes(), next);
    await tick(10);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
