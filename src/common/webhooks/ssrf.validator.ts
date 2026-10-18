import { BadRequestException } from '@nestjs/common';
import * as net from 'net';
import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

/**
 * Checks whether an IPv4 address belongs to a private, loopback, link-local,
 * metadata, or reserved non-routable range (RFC 1918, RFC 3927, RFC 1122, etc.).
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [b0, b1, b2] = parts;

  // 0.0.0.0/8 (current network)
  if (b0 === 0) return true;

  // 10.0.0.0/8 (private RFC 1918)
  if (b0 === 10) return true;

  // 127.0.0.0/8 (loopback)
  if (b0 === 127) return true;

  // 100.64.0.0/10 (carrier-grade NAT RFC 6598)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;

  // 169.254.0.0/16 (link-local, cloud metadata e.g. 169.254.169.254)
  if (b0 === 169 && b1 === 254) return true;

  // 172.16.0.0/12 (private RFC 1918: 172.16.0.0 - 172.31.255.255)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;

  // 192.0.2.0/24 (TEST-NET-1 RFC 5737)
  if (b0 === 192 && b1 === 0 && b2 === 2) return true;

  // 192.168.0.0/16 (private RFC 1918)
  if (b0 === 192 && b1 === 168) return true;

  // 198.51.100.0/24 (TEST-NET-2 RFC 5737)
  if (b0 === 198 && b1 === 51 && b2 === 100) return true;

  // 203.0.113.0/24 (TEST-NET-3 RFC 5737)
  if (b0 === 203 && b1 === 0 && b2 === 113) return true;

  // 224.0.0.0/4 (multicast) & 240.0.0.0/4 (reserved RFC 1112)
  if (b0 >= 224) return true;

  return false;
}

/**
 * Checks whether an IPv6 address belongs to a loopback, unique local, link-local,
 * IPv4-mapped, or reserved range (RFC 4193, RFC 4291).
 */
export function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // ::1 (loopback) & :: (unspecified)
  if (normalized === '::1' || normalized === '::') return true;

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:192.168.1.1)
  if (normalized.startsWith('::ffff:')) {
    const v4 = normalized.slice(7);
    if (net.isIPv4(v4)) {
      return isPrivateIPv4(v4);
    }
  }

  // Unique local addresses fc00::/7 (fc00:: - fdff::)
  if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) return true;

  // Link-local addresses fe80::/10 (fe80:: - febf::)
  if (/^fe[89ab][0-9a-f]:/i.test(normalized)) return true;

  return false;
}

/**
 * Checks whether a hostname is a loopback, private IP, or internal cloud metadata address.
 */
export function isPrivateOrInternalHost(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase().trim();

  // Localhost aliases
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // Common cloud metadata endpoints (AWS, GCP, Azure, OpenStack)
  if (
    host === 'metadata.google.internal' ||
    host === 'metadata' ||
    host === 'instance-data' ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    return true;
  }

  if (net.isIPv4(host)) {
    return isPrivateIPv4(host);
  }

  if (net.isIPv6(host)) {
    return isPrivateIPv6(host);
  }

  return false;
}

/**
 * Validates a webhook endpoint URL to prevent Server-Side Request Forgery (SSRF) (#732).
 * Throws BadRequestException if the URL points to private/internal IPs, localhost, or metadata endpoints.
 */
export function validateWebhookEndpoint(rawUrl: string): void {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new BadRequestException('Webhook URL is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestException('Invalid webhook URL format');
  }

  if (parsed.protocol !== 'https:') {
    throw new BadRequestException('Webhook URL must start with https://');
  }

  const hostname = parsed.hostname;
  if (isPrivateOrInternalHost(hostname)) {
    throw new BadRequestException(
      `Webhook endpoint cannot be a private, internal, or metadata IP address: ${hostname}`,
    );
  }
}

/**
 * Class-validator decorator for validating webhook URLs against SSRF (#732).
 */
export function IsNotPrivateUrl(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      name: 'isNotPrivateUrl',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any) {
          if (typeof value !== 'string') return false;
          try {
            validateWebhookEndpoint(value);
            return true;
          } catch {
            return false;
          }
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must not point to a private, localhost, or metadata endpoint`;
        },
      },
    });
  };
}
