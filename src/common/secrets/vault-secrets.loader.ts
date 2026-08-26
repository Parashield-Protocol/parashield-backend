import { Logger } from '@nestjs/common';

type VaultKVResponse = {
  data?: {
    data?: Record<string, unknown>;
  };
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function loadVaultSecrets(): Promise<void> {
  const logger = new Logger('VaultSecrets');
  const vaultAddr = process.env['VAULT_ADDR'];
  const vaultToken = process.env['VAULT_TOKEN'];
  const vaultPath = process.env['VAULT_KV_PATH'];

  if (!isNonEmptyString(vaultAddr) || !isNonEmptyString(vaultToken) || !isNonEmptyString(vaultPath)) {
    return;
  }

  const url = `${vaultAddr.replace(/\/$/, '')}/v1/${vaultPath.replace(/^\//, '')}`;
  const response = await fetch(url, {
    headers: {
      'X-Vault-Token': vaultToken,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Vault secret fetch failed with ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as VaultKVResponse;
  const secrets = payload.data?.data ?? {};

  for (const [key, value] of Object.entries(secrets)) {
    if (value === undefined || value === null) {
      continue;
    }
    process.env[key] = String(value);
  }

  logger.log(`Loaded ${Object.keys(secrets).length} secret(s) from Vault path ${vaultPath}`);
}
