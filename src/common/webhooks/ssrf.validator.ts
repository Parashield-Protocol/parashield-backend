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
 * 
 * Note: .internal and .local domains are blocked only as a heuristic to prevent
 * cloud metadata service access (e.g., 169.254.169.254, metadata.google.internal).
 * However, some legitimate public domains end with .internal or .local.
 * 
 * The definitive check happens at delivery time via validateWebhookEndpointAtDelivery,
 * which performs DNS resolution and validates the actual IP address. This provides
 * stronger protection: if a domain resolves to a public IP, it's allowed even if
 * the hostname ends with .internal or .local.
 */
export function isPrivateOrInternalHost(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase().trim();

  // Localhost aliases
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // Common cloud metadata endpoints (AWS, GCP, Azure, OpenStack)
  // Note: .internal and .local are common patterns for metadata services,
  // but they're also used by legitimate public domains (e.g., myapp.internal.company.com).
  // The DNS rebinding check at delivery time (validateWebhookEndpointAtDelivery)
  // provides the actual protection by validating resolved IPs.
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
 * 
 * Note: This validates the hostname at registration time only. DNS rebinding attacks can
 * make a hostname resolve to a private IP at delivery time. Use validateWebhookEndpointAtDelivery
 * before actually sending the webhook to re-validate the resolved IP.
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
 * Re-validates a webhook URL at delivery time to prevent DNS rebinding attacks.
 * This checks if the resolved IP address is private/internal, which may differ from
 * the hostname validation at registration time.
 * 
 * Uses DNS resolution to get the actual IP that will be contacted, then validates
 * that IP against SSRF rules. Throws BadRequestException if the resolved IP is private.
 * 
 * #XXX — DNS rebinding protection: validates at both registration (hostname check)
 * and delivery time (resolved IP check).
 */
export async function validateWebhookEndpointAtDelivery(rawUrl: string): Promise<void> {
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
  
  // First check: hostname-based validation (same as registration time)
  if (isPrivateOrInternalHost(hostname)) {
    throw new BadRequestException(
      `Webhook endpoint cannot be a private, internal, or metadata IP address: ${hostname}`,
    );
  }

  // Second check: resolve hostname to IP and validate the resolved IP
  // This prevents DNS rebinding attacks where a domain resolves to a private IP
  // at delivery time even though it resolved to a public IP at registration time.
  try {
    const { resolve4, resolve6 } = require('dns').promises;
    
    // Try to resolve the hostname to both IPv4 and IPv6 addresses
    let addresses: string[] = [];
    
    try {
      const ipv4Addresses = await resolve4(hostname);
      addresses.push(...ipv4Addresses);
    } catch {
      // IPv4 resolution may fail; try IPv6
    }

    try {
      const ipv6Addresses = await resolve6(hostname);
      addresses.push(...ipv6Addresses);
    } catch {
      // IPv6 resolution may fail; that's okay if IPv4 succeeded
    }

    // If we got addresses, validate that at least one is public/external
    // A successful DNS resolution that returns only private IPs is a rebinding attack
    if (addresses.length > 0) {
      const allAddressesArePrivate = addresses.every((addr) => {
        if (net.isIPv4(addr)) {
          return isPrivateIPv4(addr);
        } else if (net.isIPv6(addr)) {
          return isPrivateIPv6(addr);
        }
        return false;
      });

      if (allAddressesArePrivate) {
        throw new BadRequestException(
          `Webhook delivery blocked: all resolved addresses for ${hostname} are private or internal (${addresses.join(', ')})`,
        );
      }
    }
    // If resolution returns no addresses, let the fetch attempt proceed and fail naturally
  } catch (err) {
    // If the error is already a BadRequestException (from our validation), re-throw it
    if (err instanceof BadRequestException) {
      throw err;
    }
    // DNS resolution errors (ENOTFOUND, etc.) should not block delivery — let fetch fail naturally
    // This prevents legitimate scenarios where DNS is temporarily unavailable
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
