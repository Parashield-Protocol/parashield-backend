import {
  API_VERSION_HEADER,
  API_VERSIONS,
  DEFAULT_API_VERSION,
  SUPPORTED_API_VERSIONS,
  apiVersionHeaderValue,
  applyApiVersionHeaders,
  createApiVersionMiddleware,
  isSupportedVersion,
  normalizeVersionToken,
  resolveRequestedVersion,
  versionSegmentFromPath,
} from './api-version';

describe('api-version helpers (#713)', () => {
  describe('versionSegmentFromPath', () => {
    it('extracts the version segment from a path', () => {
      expect(versionSegmentFromPath('/api/v1/policies')).toBe('v1');
      expect(versionSegmentFromPath('/api/v2/claims?status=open')).toBe('v2');
      expect(versionSegmentFromPath('/api/v2')).toBe('v2');
    });

    it('returns the (possibly unsupported) segment so it can be rejected', () => {
      expect(versionSegmentFromPath('/api/v3/policies')).toBe('v3');
    });

    it('returns undefined when the path has no version segment', () => {
      expect(versionSegmentFromPath('/health')).toBeUndefined();
      expect(versionSegmentFromPath(undefined)).toBeUndefined();
    });
  });

  describe('normalizeVersionToken', () => {
    it.each([
      ['v1', 'v1'],
      ['V2', 'v2'],
      ['1', 'v1'],
      ['2', 'v2'],
      ['1.0', 'v1'],
      ['1.0.0', 'v1'],
      ['2.0.0', 'v2'],
    ])('normalizes %p to %p', (input, expected) => {
      expect(normalizeVersionToken(input)).toBe(expected);
    });

    it('rejects unknown values', () => {
      expect(normalizeVersionToken('nope')).toBeUndefined();
      expect(normalizeVersionToken('3')).toBeUndefined();
      expect(normalizeVersionToken('')).toBeUndefined();
      expect(normalizeVersionToken(undefined)).toBeUndefined();
    });
  });

  describe('resolveRequestedVersion', () => {
    it('prefers the path segment', () => {
      expect(resolveRequestedVersion('/api/v2/policies', 'v1')).toBe('v2');
    });

    it('falls back to the header, then the default', () => {
      expect(resolveRequestedVersion('/health', 'v2')).toBe('v2');
      expect(resolveRequestedVersion('/health')).toBe(DEFAULT_API_VERSION);
      expect(resolveRequestedVersion(undefined)).toBe(DEFAULT_API_VERSION);
    });
  });

  describe('version metadata', () => {
    it('exposes the supported versions', () => {
      expect(SUPPORTED_API_VERSIONS).toEqual(['v1', 'v2']);
      expect(API_VERSIONS.v1).toBe('1.0.0');
    });

    it('maps route segments to advertised versions', () => {
      expect(apiVersionHeaderValue('v1')).toBe('1.0.0');
      expect(apiVersionHeaderValue('v2')).toBe('2.0.0');
      expect(apiVersionHeaderValue('v9')).toBeUndefined();
      expect(isSupportedVersion('v1')).toBe(true);
      expect(isSupportedVersion('v9')).toBe(false);
    });
  });

  describe('applyApiVersionHeaders', () => {
    function fakeRes() {
      const headers: Record<string, string> = {};
      return {
        headersSent: false,
        setHeader: jest.fn((name: string, value: string) => {
          headers[name] = value;
        }),
        headers,
      };
    }

    it('sets X-API-Version and, for v1, the deprecation headers', () => {
      const res = fakeRes();
      applyApiVersionHeaders(res, 'v1');

      expect(res.setHeader).toHaveBeenCalledWith(API_VERSION_HEADER, '1.0.0');
      expect(res.setHeader).toHaveBeenCalledWith('Deprecation', 'true');
      expect(res.setHeader).toHaveBeenCalledWith('Link', '</api/v2>; rel="successor"');
    });

    it('does not mark v2 as deprecated', () => {
      const res = fakeRes();
      applyApiVersionHeaders(res, 'v2');

      expect(res.setHeader).toHaveBeenCalledWith(API_VERSION_HEADER, '2.0.0');
      expect(res.setHeader).not.toHaveBeenCalledWith('Deprecation', expect.anything());
    });

    it('is a no-op for unknown versions or already-sent responses', () => {
      const unknown = fakeRes();
      applyApiVersionHeaders(unknown, 'v9');
      expect(unknown.setHeader).not.toHaveBeenCalled();

      const sent = fakeRes();
      sent.headersSent = true;
      applyApiVersionHeaders(sent, 'v1');
      expect(sent.setHeader).not.toHaveBeenCalled();
    });

    it('is a no-op when there is no response', () => {
      expect(() => applyApiVersionHeaders(undefined, 'v1')).not.toThrow();
    });
  });

  describe('createApiVersionMiddleware', () => {
    function run(url: string, headers: Record<string, unknown> = {}) {
      const setHeader = jest.fn();
      const next = jest.fn();
      const middleware = createApiVersionMiddleware();
      middleware({ url, headers } as any, { setHeader, headersSent: false } as any, next);
      return { setHeader, next };
    }

    it('stamps the header for a versioned path', () => {
      const { setHeader, next } = run('/api/v1/policies');
      expect(setHeader).toHaveBeenCalledWith(API_VERSION_HEADER, '1.0.0');
      expect(next).toHaveBeenCalled();
    });

    it('honours the x-api-version header (including array form)', () => {
      const { setHeader } = run('/health', { 'x-api-version': ['v2'] });
      expect(setHeader).toHaveBeenCalledWith(API_VERSION_HEADER, '2.0.0');
    });
  });
});
