import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { fetchVaultSecrets, isVaultConfigured } from '../common/secrets/vault-secrets.loader';
import { PrismaService } from './prisma.service';

// Keys whose rotation PrismaService knows how to apply without a restart.
// Other secrets are read once at startup by their consumers, so they are
// deliberately not overwritten in process.env at runtime.
const DATABASE_CREDENTIAL_KEYS = ['DATABASE_URL', 'DATABASE_REPLICA_URL'] as const;

const DEFAULT_REFRESH_INTERVAL_MS = 300_000;

function getRefreshIntervalMs(): number {
  const raw = process.env.VAULT_REFRESH_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_REFRESH_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_REFRESH_INTERVAL_MS;
}

/**
 * Periodically re-reads the Vault secret loaded at startup and, when the
 * database credentials in it have changed, applies them to process.env and
 * asks PrismaService to reconnect with them.
 *
 * Only active when Vault is configured. Runs every VAULT_REFRESH_INTERVAL_MS
 * (default 5 minutes, 0 disables polling; refresh() can still be called).
 * Failures — Vault unreachable, or the new credentials not yet accepted by the
 * database — are logged and the current connections are kept, so a rotation
 * hiccup never takes the API down; the next tick retries.
 */
@Injectable()
export class DatabaseCredentialRotationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseCredentialRotationService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<boolean> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    if (!isVaultConfigured()) return;

    const intervalMs = getRefreshIntervalMs();
    if (intervalMs === 0) {
      this.logger.log('Vault credential refresh polling disabled (VAULT_REFRESH_INTERVAL_MS=0)');
      return;
    }
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref?.();
    this.logger.log(`Polling Vault for database credential rotation every ${intervalMs / 1000}s`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Fetch the current secret from Vault and rotate database connections if
   * the credentials changed. Overlapping calls share one refresh. Resolves
   * true when connections were swapped; never rejects.
   */
  refresh(): Promise<boolean> {
    this.inFlight ??= this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<boolean> {
    let secrets: Record<string, string> | null;
    try {
      secrets = await fetchVaultSecrets();
    } catch (err) {
      this.logger.warn(
        `Vault credential refresh failed, keeping current credentials: ${(err as Error).message}`,
      );
      return false;
    }
    if (!secrets) return false;

    const changed = DATABASE_CREDENTIAL_KEYS.filter(
      (key) => secrets[key] !== undefined && secrets[key] !== process.env[key],
    );
    if (changed.length === 0) return false;

    // Log key names only — never values.
    this.logger.log(`Rotated credential(s) detected in Vault: ${changed.join(', ')}`);
    const previous = Object.fromEntries(changed.map((key) => [key, process.env[key]]));
    for (const key of changed) {
      process.env[key] = secrets[key];
    }

    try {
      return await this.prisma.rotateCredentials();
    } catch {
      // PrismaService already logged why. Restore the old values so
      // process.env keeps describing the connections actually in use and the
      // next tick sees the change again and retries.
      for (const key of changed) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      return false;
    }
  }
}
