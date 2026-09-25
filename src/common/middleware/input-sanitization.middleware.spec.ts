import { Request, Response } from 'express';
import { InputSanitizationMiddleware, escapeHtml } from './input-sanitization.middleware';

describe('InputSanitizationMiddleware', () => {
  const middleware = new InputSanitizationMiddleware();

  const run = (body: unknown) => {
    const req = { body } as Request;
    const next = jest.fn();
    middleware.use(req, {} as Response, next);
    expect(next).toHaveBeenCalled();
    return req.body as unknown;
  };

  it('trims strings and escapes angle brackets', () => {
    expect(run({ name: '  <script>x</script>  ' })).toEqual({
      name: '&lt;script&gt;x&lt;/script&gt;',
    });
  });

  it('recurses into nested objects and arrays', () => {
    expect(run({ a: [{ b: '<b>' }] })).toEqual({ a: [{ b: '&lt;b&gt;' }] });
  });

  // #485 — `&` and quotes are intentionally preserved so URLs, secrets and
  // Stellar/oracle keys round-trip unchanged; output encoding is the
  // rendering layer's job (see escapeHtml).
  it('leaves & and quotes untouched so URLs and secrets are not corrupted', () => {
    const url = 'https://hooks.example.com/cb?a=1&b="2"&c=\'3\'';
    expect(run({ url })).toEqual({ url });
  });

  it('drops prototype-polluting keys at any depth (#590)', () => {
    const body = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"prototype":1,"ok":{"__proto__":{"a":1},"name":"x"}}');
    const out = run(body) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['ok']);
    expect(out.ok).toEqual({ name: 'x' });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('leaves non-plain objects and non-string primitives alone', () => {
    const date = new Date(0);
    expect(run({ n: 1, ok: true, nil: null, date })).toEqual({ n: 1, ok: true, nil: null, date });
  });
});

describe('escapeHtml (#485)', () => {
  it('encodes all five HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('prevents attribute break-out', () => {
    const payload = 'https://evil.com/?x=" onmouseover="alert(1)';
    const html = `<a href="${escapeHtml(payload)}">link</a>`;
    expect(html).toBe('<a href="https://evil.com/?x=&quot; onmouseover=&quot;alert(1)">link</a>');
  });

  it('encodes & first so existing entities are not interpreted', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('returns strings without special characters unchanged', () => {
    expect(escapeHtml('GABC123 plain text')).toBe('GABC123 plain text');
  });
});
