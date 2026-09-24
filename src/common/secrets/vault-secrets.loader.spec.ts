import { Logger } from '@nestjs/common';
import { loadVaultSecrets, VaultSecretsError } from './vault-secrets.loader';

describe('loadVaultSecrets (#496)', () => {
  const originalEnv = process.env;
  let fetchMock: jest.Mock;

  function jsonResponse(body: unknown, status = 200, statusText = 'OK') {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      json: jest.fn().mockResolvedValue(body),
    };
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
    delete process.env.VAULT_KV_PATH;
    delete process.env.VAULT_TIMEOUT_MS;
    delete process.env.VAULT_REQUIRED_KEYS;
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  function configureVault() {
    process.env.VAULT_ADDR = 'https://vault.example.com/';
    process.env.VAULT_TOKEN = 's.token';
    process.env.VAULT_KV_PATH = '/secret/data/parashield';
  }

  it('is a no-op when Vault is not configured', async () => {
    await expect(loadVaultSecrets()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails fast on partial configuration, naming the missing variables', async () => {
    process.env.VAULT_ADDR = 'https://vault.example.com';

    await expect(loadVaultSecrets()).rejects.toThrow(/VAULT_TOKEN, VAULT_KV_PATH not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('merges KV v2 secrets into process.env', async () => {
    configureVault();
    fetchMock.mockResolvedValue(jsonResponse({ data: { data: { JWT_SECRET: 'abc', NUM: 5, SKIP: null } } }));

    await loadVaultSecrets();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://vault.example.com/v1/secret/data/parashield',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Vault-Token': 's.token' }) }),
    );
    expect(process.env.JWT_SECRET).toBe('abc');
    expect(process.env.NUM).toBe('5');
    expect(process.env.SKIP).toBeUndefined();
  });

  it('wraps connection failures in a clear VaultSecretsError', async () => {
    configureVault();
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const err = await loadVaultSecrets().catch((e) => e);
    expect(err).toBeInstanceOf(VaultSecretsError);
    expect(err.message).toMatch(/Could not reach Vault at https:\/\/vault\.example\.com\/.*fetch failed/);
  });

  it('reports timeouts with the configured timeout', async () => {
    configureVault();
    process.env.VAULT_TIMEOUT_MS = '250';
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeout);

    await expect(loadVaultSecrets()).rejects.toThrow(/no response within 250ms/);
  });

  it('includes status and a hint on non-2xx responses', async () => {
    configureVault();
    fetchMock.mockResolvedValue(jsonResponse({}, 403, 'Forbidden'));

    await expect(loadVaultSecrets()).rejects.toThrow(/403 Forbidden.*VAULT_TOKEN/);
  });

  it('rejects payloads that are not KV v2 shaped', async () => {
    configureVault();
    fetchMock.mockResolvedValue(jsonResponse({ data: { JWT_SECRET: 'abc' } }));

    await expect(loadVaultSecrets()).rejects.toThrow(/no "data.data" object/);
  });

  it('names required keys that are still missing after loading', async () => {
    configureVault();
    process.env.VAULT_REQUIRED_KEYS = 'JWT_SECRET, DATABASE_URL';
    delete process.env.DATABASE_URL;
    fetchMock.mockResolvedValue(jsonResponse({ data: { data: { JWT_SECRET: 'abc' } } }));

    await expect(loadVaultSecrets()).rejects.toThrow(/Required secret\(s\) missing.*: DATABASE_URL\./);
  });
});
