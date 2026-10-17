/**
 * Validation rules for JWT_SECRET configuration (#674).
 *
 * Enforces a minimum secret length of 32 characters and rejects obviously
 * weak or placeholder values (such as previous development defaults, "secret",
 * or "changeme"). Never logs or prints any secret values.
 */

export const MIN_JWT_SECRET_LENGTH = 32;

export const REJECTED_JWT_SECRET_PLACEHOLDERS = [
  'parashield-dev-secret-change-in-production',
  'change-me-in-production',
  'changeme',
  'change-me',
  'secret',
  'jwt_secret',
  'jwt-secret',
];

export function isWeakJwtSecret(secret: string): boolean {
  if (!secret) return true;
  const s = secret.trim().toLowerCase();
  if (REJECTED_JWT_SECRET_PLACEHOLDERS.includes(s)) {
    return true;
  }
  if (
    s.includes('parashield-dev-secret') ||
    s.includes('change-me-in-production') ||
    s === 'changeme' ||
    s === 'secret'
  ) {
    return true;
  }
  return false;
}

export function validateJwtSecret(secret: string | undefined): { valid: boolean; error?: string } {
  if (!secret || !secret.trim()) {
    return { valid: false, error: 'JWT_SECRET environment variable is required' };
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    return {
      valid: false,
      error: `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters long (found ${secret.length})`,
    };
  }
  if (isWeakJwtSecret(secret)) {
    return {
      valid: false,
      error: 'JWT_SECRET must not use obviously weak or placeholder values (e.g. "secret", "changeme", or default dev secret)',
    };
  }
  return { valid: true };
}
