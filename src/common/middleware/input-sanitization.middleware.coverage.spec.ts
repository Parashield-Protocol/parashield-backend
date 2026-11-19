import { Request, Response } from 'express';
import { InputSanitizationMiddleware, escapeHtml } from './input-sanitization.middleware';

describe('InputSanitizationMiddleware coverage (#907)', () => {
  const middleware = new InputSanitizationMiddleware();

  const run = (body: unknown) => {
    const req = { body } as Request;
    const next = jest.fn();
    middleware.use(req, {} as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    return req.body as unknown;
  };

  it('escapes double and single quotes in strings', () => {
    expect(run({ q: `"x" 'y'` })).toEqual({ q: '&quot;x&quot; &#39;y&#39;' });
  });

  it('trims and sanitizes strings inside arrays', () => {
    expect(run(['  <a>  ', '  b  '])).toEqual(['&lt;a&gt;', 'b']);
  });

  it('leaves a non-object body untouched', () => {
    expect(run('  <x>  ')).toBe('  <x>  ');
  });

  it('leaves Buffer values inside a body untouched', () => {
    const buf = Buffer.from('  <b>  ');
    const out = run({ buf }) as { buf: Buffer };
    expect(out.buf).toBe(buf);
  });

  it('leaves a Buffer request body untouched', () => {
    const buf = Buffer.from('  <b>  ');
    const req = { body: buf } as Request;
    middleware.use(req, {} as Response, jest.fn());
    expect(req.body).toBe(buf);
  });

  it('stops sanitizing objects nested beyond MAX_SANITIZATION_DEPTH (10)', () => {
    // 12 wrapper levels push the leaf well past the depth limit.
    const nested = '{"child":'.repeat(12) + '{"s":"  <b>  ","constructor":{"x":1}}' + '}'.repeat(12);
    const body = JSON.parse(`{"shallow":{"s":"  <b>  "},"deep":${nested}}`);

    const out = run(body) as { shallow: { s: string }; deep: { child?: unknown } };
    expect(out.shallow).toEqual({ s: '&lt;b&gt;' });

    let node: any = out.deep;
    for (let i = 0; i < 12; i++) {
      node = node.child;
    }
    // Current behaviour: the deep leaf is returned as-is, so its string is
    // not trimmed or escaped and its forbidden key is not dropped.
    expect(node).toEqual({ s: '  <b>  ', constructor: { x: 1 } });
  });
});

describe('escapeHtml coverage (#485)', () => {
  it('returns an empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('escapes a bare ampersand', () => {
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  it('escapes every occurrence of each special character', () => {
    expect(escapeHtml(`<<>>""''&&`)).toBe('&lt;&lt;&gt;&gt;&quot;&quot;&#39;&#39;&amp;&amp;');
  });
});