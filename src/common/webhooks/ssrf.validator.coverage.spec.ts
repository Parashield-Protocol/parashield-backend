import { BadRequestException } from '@nestjs/common';
import {
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateOrInternalHost,
  validateWebhookEndpoint,
} from './ssrf.validator';

describe('SSRF validator coverage (#908)', () => {
  describe('isPrivateIPv4 range boundaries', () => {
    it.each([
      ['0.0.0.0'],
      ['0.255.255.255'],
      ['10.0.0.0'],
      ['10.255.255.255'],
      ['100.64.0.0'],
      ['100.127.255.255'],
      ['127.0.0.0'],
      ['127.255.255.255'],
      ['169.254.0.0'],
      ['169.254.255.255'],
      ['172.16.0.0'],
      ['172.31.255.255'],
      ['192.0.2.0'],
      ['192.0.2.255'],
      ['192.168.0.0'],
      ['192.168.255.255'],
      ['198.51.100.0'],
      ['198.51.100.255'],
      ['203.0.113.0'],
      ['203.0.113.255'],
      ['224.0.0.1'],
      ['239.255.255.255'],
      ['240.0.0.0'],
      ['255.255.255.255'],
    ])('detects %s as private, loopback, link-local, reserved or multicast', (ip) => {
      expect(isPrivateIPv4(ip)).toBe(true);
    });

    it.each([
      ['9.255.255.255'],
      ['11.0.0.0'],
      ['100.63.255.255'],
      ['100.128.0.0'],
      ['169.253.255.255'],
      ['169.255.0.1'],
      ['172.15.255.255'],
      ['172.32.0.0'],
      ['192.0.3.1'],
      ['192.167.255.255'],
      ['198.51.101.1'],
      ['203.0.114.1'],
      ['223.255.255.255'],
      ['8.8.8.8'],
      ['1.1.1.1'],
    ])('treats %s as public', (ip) => {
      expect(isPrivateIPv4(ip)).toBe(false);
    });

    it('returns false for malformed IPv4 strings', () => {
      expect(isPrivateIPv4('256.1.1.1')).toBe(false);
      expect(isPrivateIPv4('10.0.0')).toBe(false);
      expect(isPrivateIPv4('10.0.0.0.1')).toBe(false);
      expect(isPrivateIPv4('not-an-ip')).toBe(false);
    });
  });

  describe('isPrivateIPv6', () => {
    it.each([
      ['::1'],
      ['::'],
      ['fc00::1'],
      ['fd12:3456::1'],
      ['fe80::1'],
      ['FE80::1'],
      ['febf::1'],
      ['::ffff:127.0.0.1'],
      ['::ffff:10.1.2.3'],
      ['::ffff:192.168.1.1'],
    ])('detects %s as private or reserved', (ip) => {
      expect(isPrivateIPv6(ip)).toBe(true);
    });

    it.each([['::ffff:8.8.8.8'], ['2606:4700:4700::1111'], ['2001:4860:4860::8888']])(
      'treats %s as public',
      (ip) => {
        expect(isPrivateIPv6(ip)).toBe(false);
      },
    );
  });

  describe('isPrivateOrInternalHost', () => {
    it.each([
      ['LOCALHOST'],
      ['api.localhost'],
      ['metadata'],
      ['metadata.google.internal'],
      ['svc.internal'],
      ['printer.local'],
      ['[::1]'],
      ['10.0.0.5'],
      ['169.254.169.254'],
      ['[fd00::5]'],
    ])('blocks internal host %s', (host) => {
      expect(isPrivateOrInternalHost(host)).toBe(true);
    });

    it.each([['localhost.example.com'], ['hooks.slack.com'], ['8.8.8.8'], ['[2606:4700:4700::1111]']])(
      'allows public host %s',
      (host) => {
        expect(isPrivateOrInternalHost(host)).toBe(false);
      },
    );
  });

  describe('validateWebhookEndpoint', () => {
    it.each([
      ['https://8.8.8.8/hook'],
      ['https://[2606:4700:4700::1111]/hook'],
      ['https://example.com:8443/hooks/x?token=abc'],
      ['HTTPS://api.example.com/webhook'],
    ])('accepts public HTTPS URL %s', (url) => {
      expect(() => validateWebhookEndpoint(url)).not.toThrow();
    });

    it.each([
      ['https://224.0.0.1/hook'],
      ['https://192.0.2.10/hook'],
      ['https://198.51.100.7/hook'],
      ['https://203.0.113.9/hook'],
      ['https://[fd00::5]/hook'],
      ['https://printer.local/hook'],
      ['https://service.internal/hook'],
      ['https://metadata.google.internal/computeMetadata/v1/'],
    ])('rejects private or internal URL %s', (url) => {
      expect(() => validateWebhookEndpoint(url)).toThrow(BadRequestException);
    });

    it('rejects http:// even for a public host', () => {
      expect(() => validateWebhookEndpoint('http://8.8.8.8/hook')).toThrow(
        'Webhook URL must start with https://',
      );
    });

    it('rejects a missing or non-string URL', () => {
      expect(() => validateWebhookEndpoint(null as unknown as string)).toThrow(
        'Webhook URL is required',
      );
      expect(() => validateWebhookEndpoint(42 as unknown as string)).toThrow(
        'Webhook URL is required',
      );
    });

    it('rejects an unparseable URL with a format error', () => {
      expect(() => validateWebhookEndpoint('not-a-valid-url')).toThrow(
        'Invalid webhook URL format',
      );
    });
  });
});