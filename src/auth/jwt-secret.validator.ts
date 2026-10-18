/**
 * Validation rules for JWT_SECRET configuration (#674, #716).
 *
 * Enforces a minimum secret length of 32 characters, entropy thresholds,
 * and rejects weak or placeholder values. Never logs or prints any secret values.
 */
import { evaluateSecretEntropy, MIN_SECRET_LENGTH } from '../common/secrets/secret-validator';

export const MIN_JWT_SECRET_LENGTH = MIN_SECRET_LENGTH;

export const REJECTED_JWT_SECRET_PLACEHOLDERS = [
  'parashield-dev-secret-change-in-production',
  'change-me-in-production',
  'changeme',
  'change-me',
  'secret',
  'jwt_secret',
  'jwt-secret',
  'non-production-dev-jwt-secret-min-32-chars-long-do-not-use-in-production',
];

export function isWeakJwtSecret(secret: string): boolean {
  if (!secret) return true;
  const result = evaluateSecretEntropy(secret, MIN_JWT_SECRET_LENGTH);
  return !result.valid;
}

export function validateJwtSecret(
  secret: string | undefined,
  nodeEnv: string = process.env.NODE_ENV || 'development',
): { valid: boolean; error?: string } {
  if (!secret || !secret.trim()) {
    return { valid: false, error: 'JWT_SECRET environment variable is required' };
  }

  const isProduction = nodeEnv.toLowerCase() === 'production';
  const result = evaluateSecretEntropy(secret, MIN_JWT_SECRET_LENGTH);

  if (!result.valid) {
    if (isProduction) {
      return {
        valid: false,
        error: `JWT_SECRET is invalid: ${result.reason}`,
      };
    }
  }

  return { valid: true };
}
