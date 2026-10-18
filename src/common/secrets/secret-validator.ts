import { Logger } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';

/**
 * Validation rules and entropy heuristics for application secrets (#716).
 *
 * Ensures all secrets loaded by the application meet cryptographic strength
 * requirements before the app accepts traffic.
 *
 * In production mode (NODE_ENV=production), weak or placeholder secrets cause
 * a hard failure. In non-production modes (development, test), loud warnings
 * are logged so local setup continues to work.
 *
 * SECURITY INVARIANT: Secret values, fragments, or substrings are NEVER logged,
 * printed, or included in errors, warnings, or stack traces.
 */

export interface SecretValidationResult {
  valid: boolean;
  reason?: string;
}

export interface AllSecretsValidationReport {
  valid: boolean;
  errors: Array<{ name: string; reason: string }>;
  warnings: Array<{ name: string; reason: string }>;
}

export const MIN_SECRET_LENGTH = 32;

/**
 * Known placeholder and insecure default values collected from repository history,
 * development configs, and common default lists.
 */
export const KNOWN_PLACEHOLDERS = new Set<string>([
  'secret',
  'changeme',
  'change-me',
  'change-me-in-production',
  'password',
  'test',
  'test-key',
  'valid-api-key',
  'my-secret-key',
  'jwt_secret',
  'jwt-secret',
  'parashield-dev-secret',
  'parashield-dev-secret-change-in-production',
  'non-production-dev-jwt-secret-min-32-chars-long-do-not-use-in-production',
  'parashield',
  'redispass',
  'admin',
  'root',
  '123456',
  '12345678',
  '1234567890',
  'qwerty',
  's.xxxxxx',
  'c...',
  's...',
]);

/**
 * Calculate Shannon entropy in bits per character.
 */
export function calculateShannonEntropy(str: string): number {
  if (!str || str.length === 0) return 0;
  const frequencies = new Map<string, number>();
  for (const char of str) {
    frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
  }
  const len = str.length;
  let entropy = 0;
  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Count distinct characters in a string.
 */
export function countDistinctCharacters(str: string): number {
  return new Set(str).size;
}

/**
 * Check if string consists of a simple repeating pattern (e.g. "abcabcabc").
 */
export function hasRepeatedPattern(str: string): boolean {
  if (str.length < 4) return false;
  // Check if string is composed of repeated unit of length 1 to str.length / 2
  for (let unitLen = 1; unitLen <= Math.floor(str.length / 2); unitLen++) {
    if (str.length % unitLen === 0) {
      const unit = str.slice(0, unitLen);
      if (unit.repeat(str.length / unitLen) === str) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if string is a simple sequential character sequence (e.g. "abcdef...", "012345...").
 */
export function isSimpleSequence(str: string): boolean {
  if (str.length < 8) return false;
  let ascending = true;
  let descending = true;
  for (let i = 1; i < str.length; i++) {
    const diff = str.charCodeAt(i) - str.charCodeAt(i - 1);
    if (diff !== 1) ascending = false;
    if (diff !== -1) descending = false;
  }
  return ascending || descending;
}

/**
 * Evaluate entropy and variety for a secret string.
 * Rejects single repeated characters, simple sequences, and low distinct character counts
 * without rejecting legitimate base64 or hex values.
 */
export function evaluateSecretEntropy(secret: string, minLength = MIN_SECRET_LENGTH): SecretValidationResult {
  if (typeof secret !== 'string') {
    return { valid: false, reason: 'value must be a string' };
  }
  if (secret.length === 0 || secret.trim().length === 0) {
    return { valid: false, reason: 'value is empty or whitespace-only' };
  }
  if (secret.length < minLength) {
    return {
      valid: false,
      reason: `insufficient length (${secret.length} characters, minimum ${minLength} required)`,
    };
  }

  const normalized = secret.trim().toLowerCase();
  for (const placeholder of KNOWN_PLACEHOLDERS) {
    if (normalized === placeholder || normalized.includes(placeholder)) {
      return { valid: false, reason: 'matches known placeholder or default development value' };
    }
  }

  const distinctCount = countDistinctCharacters(secret);
  const minDistinct = Math.min(8, Math.max(3, Math.floor(minLength / 4)));
  if (distinctCount < minDistinct) {
    return {
      valid: false,
      reason: `insufficient character variety (${distinctCount} distinct characters, minimum ${minDistinct} required)`,
    };
  }

  if (hasRepeatedPattern(secret)) {
    return { valid: false, reason: 'contains simple repeating character pattern' };
  }

  if (isSimpleSequence(secret)) {
    return { valid: false, reason: 'contains simple sequential character pattern' };
  }

  const entropy = calculateShannonEntropy(secret);
  // A threshold of 2.5 bits per character permits legitimate hex (>= 3.0) and base64 (>= 3.5)
  // while rejecting low-variety and repetitive sequences.
  if (entropy < 2.5) {
    return {
      valid: false,
      reason: `low Shannon entropy (${entropy.toFixed(2)} bits/char, minimum 2.50 required)`,
    };
  }

  return { valid: true };
}

/**
 * Validate a Stellar secret key (KEEPER_SECRET_KEY).
 * Stellar secret keys start with 'S', are 56 characters long, base32 encoded,
 * and validatable via Keypair.fromSecret().
 */
export function validateStellarSecretKey(secret: unknown): SecretValidationResult {
  if (typeof secret !== 'string' || !secret.trim()) {
    return { valid: false, reason: 'value is empty or whitespace-only' };
  }
  const s = secret.trim();
  if (KNOWN_PLACEHOLDERS.has(s.toLowerCase())) {
    return { valid: false, reason: 'matches known placeholder or default value' };
  }
  if (!s.startsWith('S') || s.length !== 56) {
    return {
      valid: false,
      reason: 'invalid Stellar secret key format (must start with "S" and be 56 characters long)',
    };
  }
  try {
    Keypair.fromSecret(s);
    return { valid: true };
  } catch {
    return { valid: false, reason: 'invalid Stellar secret key encoding' };
  }
}

/**
 * Validate PostgreSQL connection URL.
 * Checks format and ensures any embedded password is not a known weak placeholder.
 */
export function validateDatabaseUrl(url: unknown): SecretValidationResult {
  if (typeof url !== 'string' || !url.trim()) {
    return { valid: false, reason: 'value is empty or whitespace-only' };
  }
  const u = url.trim();
  if (!u.startsWith('postgresql://') && !u.startsWith('postgres://')) {
    return {
      valid: false,
      reason: 'must be a valid PostgreSQL connection URL (postgresql:// or postgres://)',
    };
  }

  try {
    const parsed = new URL(u);
    const password = parsed.password;
    if (password) {
      const decodedPassword = decodeURIComponent(password).toLowerCase();
      if (KNOWN_PLACEHOLDERS.has(decodedPassword)) {
        return {
          valid: false,
          reason: 'database URL contains known weak placeholder password',
        };
      }
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: 'malformed database URL' };
  }
}

/**
 * Validate Redis connection URL.
 */
export function validateRedisUrl(url: unknown): SecretValidationResult {
  if (typeof url !== 'string' || !url.trim()) {
    return { valid: false, reason: 'value is empty or whitespace-only' };
  }
  const u = url.trim();
  if (!u.startsWith('redis://') && !u.startsWith('rediss://')) {
    return {
      valid: false,
      reason: 'must be a valid Redis connection URL (redis:// or rediss://)',
    };
  }

  try {
    const parsed = new URL(u);
    const password = parsed.password;
    if (password) {
      const decodedPassword = decodeURIComponent(password).toLowerCase();
      if (KNOWN_PLACEHOLDERS.has(decodedPassword)) {
        return {
          valid: false,
          reason: 'Redis URL contains known weak placeholder password',
        };
      }
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: 'malformed Redis URL' };
  }
}

/**
 * Validate a third-party API key (e.g. AviationStack).
 */
export function validateAviationStackKey(apiKey: unknown): SecretValidationResult {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    return { valid: false, reason: 'value is empty or whitespace-only' };
  }
  const s = apiKey.trim().toLowerCase();
  if (KNOWN_PLACEHOLDERS.has(s)) {
    return { valid: false, reason: 'matches known placeholder value' };
  }
  if (s.length < 16) {
    return { valid: false, reason: 'API key is too short (minimum 16 characters)' };
  }
  return { valid: true };
}

export type SecretType =
  | 'jwt'
  | 'api_key'
  | 'stellar_key'
  | 'database_url'
  | 'redis_url'
  | 'generic_secret'
  | 'aviationstack_key';

export interface SecretDefinition {
  name: string;
  type: SecretType;
  required: boolean;
  minLength?: number;
}

export const SECRET_DEFINITIONS: SecretDefinition[] = [
  { name: 'JWT_SECRET', type: 'jwt', required: true, minLength: 32 },
  { name: 'KEEPER_SECRET_KEY', type: 'stellar_key', required: true },
  { name: 'DATABASE_URL', type: 'database_url', required: true },
  { name: 'DATABASE_REPLICA_URL', type: 'database_url', required: false },
  { name: 'ORACLE_OPERATOR_API_KEY', type: 'api_key', required: false, minLength: 32 },
  { name: 'ADMIN_API_KEY', type: 'api_key', required: false, minLength: 32 },
  { name: 'ORACLE_OPERATOR_API_KEY_PREVIOUS', type: 'api_key', required: false, minLength: 32 },
  { name: 'ADMIN_API_KEY_PREVIOUS', type: 'api_key', required: false, minLength: 32 },
  { name: 'WEBHOOK_SECRET_KEY', type: 'generic_secret', required: false, minLength: 32 },
  { name: 'REDIS_URL', type: 'redis_url', required: false },
  { name: 'AVIATIONSTACK_API_KEY', type: 'aviationstack_key', required: false },
];

/**
 * Validate a single secret by its definition.
 */
export function validateSecretValue(
  def: SecretDefinition,
  value: unknown,
): SecretValidationResult {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (def.required) {
      return { valid: false, reason: 'required secret is missing or empty' };
    }
    return { valid: true };
  }

  const str = String(value);

  switch (def.type) {
    case 'stellar_key':
      return validateStellarSecretKey(str);
    case 'database_url':
      return validateDatabaseUrl(str);
    case 'redis_url':
      return validateRedisUrl(str);
    case 'aviationstack_key':
      return validateAviationStackKey(str);
    case 'jwt':
    case 'api_key':
    case 'generic_secret':
    default:
      return evaluateSecretEntropy(str, def.minLength ?? MIN_SECRET_LENGTH);
  }
}

/**
 * Validate all configuration secrets.
 *
 * In production: throws an Error if any required secret is missing or any secret is weak.
 * In non-production: logs loud warnings for weak secrets without failing startup.
 */
export function validateAllSecrets(
  config: Record<string, unknown>,
  nodeEnv: string = process.env.NODE_ENV || 'development',
): AllSecretsValidationReport {
  const logger = new Logger('SecretValidation');
  const isProduction = nodeEnv.toLowerCase() === 'production';
  const report: AllSecretsValidationReport = {
    valid: true,
    errors: [],
    warnings: [],
  };

  // At least one of ORACLE_OPERATOR_API_KEY or ADMIN_API_KEY is required
  const hasOperatorKey = typeof config['ORACLE_OPERATOR_API_KEY'] === 'string' && config['ORACLE_OPERATOR_API_KEY'].trim().length > 0;
  const hasAdminKey = typeof config['ADMIN_API_KEY'] === 'string' && config['ADMIN_API_KEY'].trim().length > 0;

  if (!hasOperatorKey && !hasAdminKey) {
    const message = 'At least one of ORACLE_OPERATOR_API_KEY or ADMIN_API_KEY is required';
    if (isProduction) {
      report.errors.push({ name: 'ORACLE_OPERATOR_API_KEY/ADMIN_API_KEY', reason: message });
      report.valid = false;
    } else {
      report.warnings.push({ name: 'ORACLE_OPERATOR_API_KEY/ADMIN_API_KEY', reason: message });
    }
  }

  for (const def of SECRET_DEFINITIONS) {
    const value = config[def.name];
    const result = validateSecretValue(def, value);

    if (!result.valid) {
      const reason = result.reason!;
      if (isProduction) {
        report.valid = false;
        report.errors.push({ name: def.name, reason });
      } else {
        // In non-production, missing required secrets are errors, while weak secrets are warnings
        if (def.required && (value === undefined || value === null || (typeof value === 'string' && value.trim() === ''))) {
          report.valid = false;
          report.errors.push({ name: def.name, reason });
        } else {
          report.warnings.push({ name: def.name, reason });
        }
      }
    }
  }

  // Log warnings in non-production
  for (const warning of report.warnings) {
    logger.warn(
      `[SECURITY WARNING] Secret "${warning.name}" is weak: ${warning.reason}. ` +
      'In production this will prevent startup. Rotate this secret before deploying to production.',
    );
  }

  if (!report.valid && isProduction) {
    const errorDetails = report.errors
      .map((e) => ` - ${e.name}: ${e.reason}`)
      .join('\n');
    throw new Error(
      `Production secret validation failed:\n${errorDetails}\n` +
      'All secrets must be strong and non-placeholder before deploying to production.',
    );
  }

  return report;
}
