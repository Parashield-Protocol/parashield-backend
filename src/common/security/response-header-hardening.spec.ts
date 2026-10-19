import express from 'express';
import type { Express } from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import {
  LEAKY_RESPONSE_HEADERS,
  SecurityHeaderApp,
  applySecurityHeaders,
  createHeaderStrippingMiddleware,
} from './response-header-hardening';

/** Minimal fake Express `Response` that records whatever reaches the socket. */
function fakeRes() {
  const headers = new Map<string, unknown>();
  const res = {
    lastWriteHead: undefined as unknown[] | undefined,
    setHeader(name: string, value: unknown) {
      headers.set(name.toLowerCase(), value);
      return res;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    removeHeader(name: string) {
      headers.delete(name.toLowerCase());
    },
    getHeaderNames() {
      return Array.from(headers.keys());
    },
    writeHead(...args: unknown[]) {
      res.lastWriteHead = args;
      return res;
    },
    has(name: string) {
      return headers.has(name.toLowerCase());
    },
  };
  return res;
}

function runMiddleware(res: ReturnType<typeof fakeRes>) {
  const middleware = createHeaderStrippingMiddleware();
  const next = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  middleware({} as any, res as any, next);
  return next;
}

async function withServer(
  app: Express,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function request(
  port: number,
  path: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      })
      .on('error', reject);
  });
}

describe('response header hardening (#711)', () => {
  describe('createHeaderStrippingMiddleware', () => {
    it('strips every leaky header set after the middleware runs', () => {
      const res = fakeRes();
      const next = runMiddleware(res);
      expect(next).toHaveBeenCalledTimes(1);

      for (const name of LEAKY_RESPONSE_HEADERS) {
        res.setHeader(name, 'some-value');
      }

      for (const name of LEAKY_RESPONSE_HEADERS) {
        expect(res.has(name)).toBe(false);
      }
    });

    it('is case-insensitive', () => {
      const res = fakeRes();
      runMiddleware(res);

      res.setHeader('sErVeR', 'nginx');
      res.setHeader('X-POWERED-BY', 'Express');

      expect(res.has('Server')).toBe(false);
      expect(res.has('X-Powered-By')).toBe(false);
    });

    it('leaves other headers untouched', () => {
      const res = fakeRes();
      runMiddleware(res);

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Total-Count', '42');

      expect(res.getHeader('Content-Type')).toBe('application/json');
      expect(res.getHeader('X-Total-Count')).toBe('42');
    });

    it('removes leaky headers that were already set before the middleware', () => {
      const res = fakeRes();
      res.setHeader('Server', 'upstream/1.2.3');
      res.setHeader('X-Runtime', '0.012');

      runMiddleware(res);

      expect(res.has('Server')).toBe(false);
      expect(res.has('X-Runtime')).toBe(false);
    });

    it('filters headers passed directly to writeHead', () => {
      const res = fakeRes();
      runMiddleware(res);

      res.writeHead(200, {
        Server: 'nginx',
        'X-Powered-By': 'Express',
        'Content-Type': 'text/plain',
      });

      const headersArg = res.lastWriteHead?.[1] as Record<string, unknown>;
      expect(headersArg).not.toHaveProperty('Server');
      expect(headersArg).not.toHaveProperty('X-Powered-By');
      expect(headersArg).toHaveProperty('Content-Type', 'text/plain');
    });

    it('supports a custom denylist', () => {
      const res = fakeRes();
      const middleware = createHeaderStrippingMiddleware(['X-Internal-Trace']);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      middleware({} as any, res as any, jest.fn());

      res.setHeader('X-Internal-Trace', 'abc');
      res.setHeader('Server', 'nginx');

      expect(res.has('X-Internal-Trace')).toBe(false);
      // Not in the custom list, so it survives this layer.
      expect(res.has('Server')).toBe(true);
    });
  });

  describe('applySecurityHeaders', () => {
    it('disables x-powered-by and installs helmet + stripping middleware', () => {
      const app: SecurityHeaderApp = {
        use: jest.fn().mockReturnThis(),
        disable: jest.fn().mockReturnThis(),
      };

      const strip = applySecurityHeaders(app);

      expect(app.disable).toHaveBeenCalledWith('x-powered-by');
      expect(app.use).toHaveBeenCalledTimes(2);
      expect(typeof strip).toBe('function');
    });

    it('removes X-Powered-By and Server end-to-end', async () => {
      const app = express();
      applySecurityHeaders(app as unknown as SecurityHeaderApp);
      app.get('/ok', (_req, res) => {
        res.json({ ok: true });
      });
      app.get('/upstream', (_req, res) => {
        // Simulate a reverse proxy / upstream stack adding leaky headers.
        res.setHeader('Server', 'nginx/1.25.0');
        res.setHeader('X-Runtime', '0.010');
        res.setHeader('Via', '1.1 vegur');
        res.json({ ok: true });
      });

      await withServer(app, async (port) => {
        const plain = await request(port, '/ok');
        expect(plain.status).toBe(200);
        expect(plain.headers['x-powered-by']).toBeUndefined();
        expect(plain.headers['server']).toBeUndefined();
        // helmet's standard headers are still applied.
        expect(plain.headers['x-content-type-options']).toBe('nosniff');

        const upstream = await request(port, '/upstream');
        expect(upstream.status).toBe(200);
        expect(upstream.headers['server']).toBeUndefined();
        expect(upstream.headers['x-runtime']).toBeUndefined();
        expect(upstream.headers['via']).toBeUndefined();
        expect(upstream.headers['x-powered-by']).toBeUndefined();
      });
    });
  });
});
