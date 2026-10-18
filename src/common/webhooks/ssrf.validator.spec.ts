import { BadRequestException } from '@nestjs/common';
import {
  validateWebhookEndpoint,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateOrInternalHost,
} from './ssrf.validator';

describe('SSRF Validator (#732)', () => {
  describe('validateWebhookEndpoint', () => {
    it('allows valid public HTTPS webhook URLs', () => {
      expect(() =>
        validateWebhookEndpoint('https://api.example.com/webhooks/notify'),
      ).not.toThrow();
      expect(() =>
        validateWebhookEndpoint('https://hooks.slack.com/services/T00/B00/XXXX'),
      ).not.toThrow();
      expect(() =>
        validateWebhookEndpoint('https://discord.com/api/webhooks/123/abc'),
      ).not.toThrow();
    });

    it('rejects non-HTTPS URLs', () => {
      expect(() =>
        validateWebhookEndpoint('http://api.example.com/webhook'),
      ).toThrow(BadRequestException);
      expect(() =>
        validateWebhookEndpoint('ftp://api.example.com/webhook'),
      ).toThrow(BadRequestException);
    });

    it('rejects invalid URL strings', () => {
      expect(() => validateWebhookEndpoint('')).toThrow(BadRequestException);
      expect(() => validateWebhookEndpoint('not-a-valid-url')).toThrow(
        BadRequestException,
      );
    });

    it('rejects loopback addresses', () => {
      expect(() => validateWebhookEndpoint('https://localhost/webhook')).toThrow(
        BadRequestException,
      );
      expect(() => validateWebhookEndpoint('https://127.0.0.1/webhook')).toThrow(
        BadRequestException,
      );
      expect(() => validateWebhookEndpoint('https://127.0.1.1:8080/hook')).toThrow(
        BadRequestException,
      );
      expect(() => validateWebhookEndpoint('https://[::1]/webhook')).toThrow(
        BadRequestException,
      );
    });

    it('rejects private IPv4 addresses (RFC 1918)', () => {
      expect(() => validateWebhookEndpoint('https://10.0.0.1/webhook')).toThrow(
        BadRequestException,
      );
      expect(() =>
        validateWebhookEndpoint('https://172.16.0.1/webhook'),
      ).toThrow(BadRequestException);
      expect(() =>
        validateWebhookEndpoint('https://172.31.255.255/webhook'),
      ).toThrow(BadRequestException);
      expect(() =>
        validateWebhookEndpoint('https://192.168.1.100/webhook'),
      ).toThrow(BadRequestException);
    });

    it('rejects cloud metadata and link-local addresses (RFC 3927)', () => {
      expect(() =>
        validateWebhookEndpoint('https://169.254.169.254/latest/meta-data'),
      ).toThrow(BadRequestException);
      expect(() =>
        validateWebhookEndpoint('https://metadata.google.internal/computeMetadata'),
      ).toThrow(BadRequestException);
      expect(() =>
        validateWebhookEndpoint('https://instance-data/latest/meta-data'),
      ).toThrow(BadRequestException);
    });

    it('rejects carrier-grade NAT and reserved addresses', () => {
      expect(() =>
        validateWebhookEndpoint('https://100.64.0.1/webhook'),
      ).toThrow(BadRequestException);
      expect(() =>
        validateWebhookEndpoint('https://0.0.0.0/webhook'),
      ).toThrow(BadRequestException);
    });

    it('rejects private IPv6 addresses (Unique Local & Link-Local)', () => {
      expect(() => validateWebhookEndpoint('https://[fc00::1]/webhook')).toThrow(
        BadRequestException,
      );
      expect(() => validateWebhookEndpoint('https://[fe80::1]/webhook')).toThrow(
        BadRequestException,
      );
    });
  });

  describe('isPrivateIPv4', () => {
    it('identifies private and reserved IPv4 ranges', () => {
      expect(isPrivateIPv4('127.0.0.1')).toBe(true);
      expect(isPrivateIPv4('10.254.0.1')).toBe(true);
      expect(isPrivateIPv4('172.20.10.2')).toBe(true);
      expect(isPrivateIPv4('192.168.0.1')).toBe(true);
      expect(isPrivateIPv4('169.254.169.254')).toBe(true);
      expect(isPrivateIPv4('100.100.100.100')).toBe(true);
      expect(isPrivateIPv4('8.8.8.8')).toBe(false);
      expect(isPrivateIPv4('1.1.1.1')).toBe(false);
      expect(isPrivateIPv4('93.184.216.34')).toBe(false);
    });
  });

  describe('isPrivateOrInternalHost', () => {
    it('identifies internal and metadata hostnames', () => {
      expect(isPrivateOrInternalHost('localhost')).toBe(true);
      expect(isPrivateOrInternalHost('test.localhost')).toBe(true);
      expect(isPrivateOrInternalHost('metadata.google.internal')).toBe(true);
      expect(isPrivateOrInternalHost('instance-data')).toBe(true);
      expect(isPrivateOrInternalHost('internal.service.local')).toBe(true);
      expect(isPrivateOrInternalHost('google.com')).toBe(false);
      expect(isPrivateOrInternalHost('github.com')).toBe(false);
    });
  });
});
