import { Logger } from '@nestjs/common';

type VaultKVResponse = {
  data?: {
    data?: Record<string, unknown>;
  };
};

const VAULT_CONFIG_VARS = ['VAULT_ADDR', 'VAULT_TOKEN', 'VAULT_KV_PATH'] as const;
const DEFAULT_VAULT_TIMEOUT_MS = 5_000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseCsv(value: string | undefined): string[] {
  if (!isNonEmptyString(value)) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

/**
 * #496 — raised whenever Vault is configured but secrets could not be loaded.
 * Loading runs before Nest bootstraps, so the caller must treat this as fatal:
 * starting without the expected secrets only defers the failure to some
 * later, harder-to-diagnose point.
 */
export class VaultSecretsError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'VaultSecretsError';
    this.cause = options?.cause;
  }
}

/**
 * Fetch a KV v2 secret from HashiCorp Vault and merge it into process.env.
 *
 * Vault is opt-in: when none of VAULT_ADDR / VAULT_TOKEN / VAULT_KV_PATH are
 * set this is a no-op. Once any of them is set, every failure is fatal and
 * reported with a VaultSecretsError that says what went wrong:
 *  - partial configuration (names the missing variables)
 *  - Vault unreachable or not answering within VAULT_TIMEOUT_MS (default 5s)
 *  - non-2xx response or a payload that isn't KV v2 shaped (`data.data`)
 *  - keys listed in VAULT_REQUIRED_KEYS that are in neither the secret nor
 *    the existing environment (names the missing keys)
 */
export async function loadVaultSecrets(): Promise<void> {
  const logger = new Logger('VaultSecrets');

  const configured = VAULT_CONFIG_VARS.filter((name) => isNonEmptyString(process.env[name]));
  if (configured.length === 0) {
    return;
  }
  if (configured.length < VAULT_CONFIG_VARS.length) {
    const missing = VAULT_CONFIG_VARS.filter((name) => !configured.includes(name));
    throw new VaultSecretsError(
      `Vault is partially configured: ${missing.join(', ')} not set. ` +
      `Set all of ${VAULT_CONFIG_VARS.join(', ')} to load secrets from Vault, or unset them all to use plain environment variables.`,
    );
  }

  const vaultAddr = process.env['VAULT_ADDR']!;
  const vaultToken = process.env['VAULT_TOKEN']!;
  const vaultPath = process.env['VAULT_KV_PATH']!;
  const timeoutMs = parseInt(process.env['VAULT_TIMEOUT_MS'] ?? '', 10) || DEFAULT_VAULT_TIMEOUT_MS;

  const url = `${vaultAddr.replace(/\/$/, '')}/v1/${vaultPath.replace(/^\//, '')}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'X-Vault-Token': vaultToken,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = (err as Error).name === 'TimeoutError'
      ? `no response within ${timeoutMs}ms`
      : (err as Error).message;
    throw new VaultSecretsError(
      `Could not reach Vault at ${vaultAddr} (path ${vaultPath}): ${reason}. ` +
      'Check VAULT_ADDR and network connectivity to Vault.',
      { cause: err },
    );
  }

  if (!response.ok) {
    const hint = response.status === 403
      ? ' Check that VAULT_TOKEN is valid and its policy grants read on this path.'
      : response.status === 404
        ? ' Check VAULT_KV_PATH (KV v2 paths include "/data/", e.g. secret/data/parashield/backend).'
        : '';
    throw new VaultSecretsError(
      `Vault secret fetch from ${vaultAddr} (path ${vaultPath}) failed with ${response.status} ${response.statusText}.${hint}`,
    );
  }

  let payload: VaultKVResponse;
  try {
    payload = (await response.json()) as VaultKVResponse;
  } catch (err) {
    throw new VaultSecretsError(
      `Vault response for path ${vaultPath} was not valid JSON.`,
      { cause: err },
    );
  }

  const secrets = payload?.data?.data;
  if (!secrets || typeof secrets !== 'object') {
    throw new VaultSecretsError(
      `Vault response for path ${vaultPath} has no "data.data" object. ` +
      'Is VAULT_KV_PATH pointing at a KV v2 secret?',
    );
  }

  const loaded: string[] = [];
  for (const [key, value] of Object.entries(secrets)) {
    if (value === undefined || value === null) {
      continue;
    }
    process.env[key] = String(value);
    loaded.push(key);
  }

  const missingRequired = parseCsv(process.env['VAULT_REQUIRED_KEYS'])
    .filter((key) => !isNonEmptyString(process.env[key]));
  if (missingRequired.length > 0) {
    throw new VaultSecretsError(
      `Required secret(s) missing after loading Vault path ${vaultPath}: ${missingRequired.join(', ')}. ` +
      'Add them to the Vault secret or set them as environment variables.',
    );
  }

  if (loaded.length === 0) {
    logger.warn(`Vault path ${vaultPath} returned no secrets`);
  } else {
    // Log key names only — never values.
    logger.log(`Loaded ${loaded.length} secret(s) from Vault path ${vaultPath}: ${loaded.join(', ')}`);
  }
}
