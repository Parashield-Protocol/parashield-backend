import { parseTrustProxy } from './trust-proxy';

describe('parseTrustProxy (#494)', () => {
  it('defaults to trusting no proxies', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('  ')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('FALSE')).toBe(false);
  });

  it('parses "true"', () => {
    expect(parseTrustProxy('true')).toBe(true);
  });

  it('parses a hop count', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy(' 2 ')).toBe(2);
  });

  it('parses a comma-separated list of addresses/presets', () => {
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toEqual(['loopback', '10.0.0.0/8']);
  });
});
