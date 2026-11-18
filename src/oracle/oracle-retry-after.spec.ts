import { rateLimitRetryDelayMs } from './oracle.service';

/**
 * #820 — a 429 with a missing or non-numeric Retry-After must not produce a
 * NaN delay (setTimeout(fn, NaN) fires immediately → tight retry loop).
 */
describe('rateLimitRetryDelayMs (#820)', () => {
  it('uses the Retry-After seconds when numeric', () => {
    expect(rateLimitRetryDelayMs('5', 0)).toBe(5000);
    expect(rateLimitRetryDelayMs(3, 2)).toBe(3000);
    expect(rateLimitRetryDelayMs('0', 1)).toBe(0);
  });

  it.each([undefined, null, '', 'soon', 'Wed, 21 Oct 2026 07:28:00 GMT', '-4', {}])(
    'falls back to exponential backoff for Retry-After %p',
    (retryAfter) => {
      expect(rateLimitRetryDelayMs(retryAfter, 0)).toBe(1000);
      expect(rateLimitRetryDelayMs(retryAfter, 2)).toBe(4000);
    },
  );

  it('never returns NaN', () => {
    for (const value of [undefined, 'abc', NaN, Infinity]) {
      expect(Number.isNaN(rateLimitRetryDelayMs(value, 1))).toBe(false);
    }
  });
});
