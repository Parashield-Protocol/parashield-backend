import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// #381 — Prisma sizes its connection pool from DATABASE_URL parameters, not
// from schema.prisma, so the defaults (num_cpus * 2 + 1 connections, 10s
// pool timeout) are implicit and untuned. Apply explicit production-friendly
// defaults here; operators can override each value via env vars or by setting
// the parameter directly in DATABASE_URL (explicit URL params always win).
const DEFAULT_CONNECTION_LIMIT = '10';
const DEFAULT_POOL_TIMEOUT_SECONDS = '10';
const DEFAULT_CONNECT_TIMEOUT_SECONDS = '5';

export interface PrismaPoolConfig {
  connectionLimit: number;
  poolTimeout: number;
  connectTimeout: number;
}

/**
 * Determine the effective pool configuration. Explicit query parameters in the
 * connection URL take precedence over environment variables.
 */
function getEffectivePoolConfig(url: string | undefined): PrismaPoolConfig {
  let connectionLimit = process.env.DATABASE_CONNECTION_LIMIT || DEFAULT_CONNECTION_LIMIT;
  let poolTimeout = process.env.DATABASE_POOL_TIMEOUT || DEFAULT_POOL_TIMEOUT_SECONDS;
  let connectTimeout = process.env.DATABASE_CONNECT_TIMEOUT || DEFAULT_CONNECT_TIMEOUT_SECONDS;

  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.has('connection_limit')) {
        connectionLimit = parsed.searchParams.get('connection_limit')!;
      }
      if (parsed.searchParams.has('pool_timeout')) {
        poolTimeout = parsed.searchParams.get('pool_timeout')!;
      }
      if (parsed.searchParams.has('connect_timeout')) {
        connectTimeout = parsed.searchParams.get('connect_timeout')!;
      }
    } catch {
      // Ignore URL parsing errors
    }
  }

  return {
    connectionLimit: parseInt(connectionLimit, 10),
    poolTimeout: parseInt(poolTimeout, 10),
    connectTimeout: parseInt(connectTimeout, 10),
  };
}

/**
 * Append Prisma connection-pool parameters to the datasource URL.
 * Parameters already present in the URL are left untouched, and URLs that
 * fail to parse are returned unchanged so startup never breaks on them.
 */
function withConnectionPoolParams(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('connection_limit')) {
      parsed.searchParams.set('connection_limit', process.env.DATABASE_CONNECTION_LIMIT || DEFAULT_CONNECTION_LIMIT);
    }
    if (!parsed.searchParams.has('pool_timeout')) {
      parsed.searchParams.set('pool_timeout', process.env.DATABASE_POOL_TIMEOUT || DEFAULT_POOL_TIMEOUT_SECONDS);
    }
    if (!parsed.searchParams.has('connect_timeout')) {
      parsed.searchParams.set('connect_timeout', process.env.DATABASE_CONNECT_TIMEOUT || DEFAULT_CONNECT_TIMEOUT_SECONDS);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

const DEFAULT_QUERY_CACHE_TTL_SECONDS = 30;

// After a credential rotation the previous clients are kept alive for this
// long so in-flight queries and interactive transactions can finish before
// their pools are closed. Override with DATABASE_ROTATION_DRAIN_MS.
const DEFAULT_ROTATION_DRAIN_MS = 30_000;

function getRotationDrainMs(): number {
  const parsed = parseInt(process.env.DATABASE_ROTATION_DRAIN_MS ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_ROTATION_DRAIN_MS;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

// Database credentials can rotate at runtime (see rotateCredentials), and a
// PrismaClient's datasource URL is fixed once constructed. PrismaService
// therefore wraps a swappable client instead of extending PrismaClient: the
// interface merge below keeps the full PrismaClient API on PrismaService, and
// the Proxy returned from the constructor forwards everything PrismaService
// doesn't define itself to whichever client is current.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface PrismaService extends PrismaClient {}

@Injectable()
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  // Primary client; replaced on credential rotation.
  private client: PrismaClient;

  // #439 — Read replica client. Instantiated only when DATABASE_REPLICA_URL
  // is set; otherwise reader falls back to the primary so callers need no
  // conditional logic and existing code paths are unchanged.
  private replicaClient: PrismaClient | null;

  // Raw URLs the current clients were built from, compared against
  // process.env to detect rotated credentials.
  private primaryUrl: string | undefined;
  private replicaUrl: string | undefined;

  // Serializes rotations so two refreshes never race on the swap.
  private rotation: Promise<boolean> = Promise.resolve(false);

  // Clients replaced by a rotation, waiting out the drain period.
  private readonly retiring = new Map<NodeJS.Timeout, PrismaClient[]>();

  // In-process TTL cache for repeated read queries (e.g. product lookups,
  // config-style tables) that are hit frequently but change rarely. Callers
  // opt in explicitly via `cachedQuery`; nothing is cached implicitly, so
  // writes and transactions are never affected.
  private readonly queryCache = new Map<string, CacheEntry>();

  public poolConfig: PrismaPoolConfig;

  constructor() {
    this.primaryUrl = process.env.DATABASE_URL;
    this.client = this.createClient(this.primaryUrl);
    this.poolConfig = getEffectivePoolConfig(this.primaryUrl);

    this.replicaUrl = process.env.DATABASE_REPLICA_URL;
    this.replicaClient = this.replicaUrl ? this.createClient(this.replicaUrl) : null;

    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        const value = Reflect.get(target.client, prop);
        return typeof value === 'function' ? value.bind(target.client) : value;
      },
    });
  }

  /** Builds a client for `url` with the pool parameters applied. */
  protected createClient(url: string | undefined): PrismaClient {
    return new PrismaClient({ datasourceUrl: withConnectionPoolParams(url) });
  }

  /**
   * Returns the read-replica PrismaClient when DATABASE_REPLICA_URL is
   * configured, otherwise returns the primary client.
   *
   * Use this for all read-only queries (findMany, findFirst, findUnique,
   * count, aggregate) to offload traffic from the primary.
   * Always use `this.prisma` (the primary) for writes and $transactions.
   *
   * @example
   *   const items = await this.prisma.reader.policy.findMany({ ... });
   */
  get reader(): PrismaClient {
    return this.replicaClient ?? this;
  }

  /**
   * Picks up rotated database credentials without a restart.
   *
   * Re-reads DATABASE_URL and DATABASE_REPLICA_URL from process.env; for each
   * one that changed, a new client is built and connected *before* it is
   * swapped in, so a bad or not-yet-active credential never replaces a
   * working connection — the error is thrown and the current clients stay in
   * place (the next rotation attempt retries). Once swapped, new queries use
   * the new credentials, while the replaced clients are disconnected only
   * after DATABASE_ROTATION_DRAIN_MS (default 30s) so in-flight queries and
   * transactions can complete.
   *
   * Rotations are serialized. Resolves true when any client was swapped.
   */
  rotateCredentials(): Promise<boolean> {
    this.rotation = this.rotation
      .catch(() => false)
      .then(() => this.swapClientsIfCredentialsChanged());
    return this.rotation;
  }

  private async swapClientsIfCredentialsChanged(): Promise<boolean> {
    const primaryUrl = process.env.DATABASE_URL;
    const replicaUrl = process.env.DATABASE_REPLICA_URL;
    const primaryChanged = primaryUrl !== this.primaryUrl;
    const replicaChanged = replicaUrl !== this.replicaUrl;
    if (!primaryChanged && !replicaChanged) {
      return false;
    }

    const nextPrimary = primaryChanged ? this.createClient(primaryUrl) : null;
    const nextReplica = replicaChanged && replicaUrl ? this.createClient(replicaUrl) : null;
    try {
      await nextPrimary?.$connect();
      await nextReplica?.$connect();
    } catch (err) {
      await this.disconnectQuietly([nextPrimary, nextReplica]);
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Database credential rotation failed, keeping existing connections: ${errorMsg}`,
      );
      throw err;
    }

    const retired: PrismaClient[] = [];
    const rotated: string[] = [];
    if (nextPrimary) {
      retired.push(this.client);
      this.client = nextPrimary;
      this.primaryUrl = primaryUrl;
      this.poolConfig = getEffectivePoolConfig(primaryUrl);
      rotated.push('primary');
    }
    if (replicaChanged) {
      if (this.replicaClient) retired.push(this.replicaClient);
      this.replicaClient = nextReplica;
      this.replicaUrl = replicaUrl;
      rotated.push('replica');
    }

    const drainMs = getRotationDrainMs();
    const timer = setTimeout(() => {
      this.retiring.delete(timer);
      void this.disconnectQuietly(retired);
    }, drainMs);
    timer.unref?.();
    this.retiring.set(timer, retired);

    this.logger.log(
      `Database credentials rotated (${rotated.join(', ')}); ` +
      `previous connections close in ${drainMs / 1000}s`,
    );
    return true;
  }

  private async disconnectQuietly(clients: Array<PrismaClient | null>): Promise<void> {
    await Promise.all(clients.map(async (client) => {
      if (!client) return;
      try {
        await client.$disconnect();
      } catch (err) {
        this.logger.warn(
          `Failed to disconnect retired database client: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }));
  }

  async onModuleInit() {
    // #696 — Handle SIGTERM / SIGINT signals gracefully
    process.once('SIGTERM', async () => {
      this.logger.log('SIGTERM signal received: disconnecting Prisma client...');
      await this.onModuleDestroy();
    });
    process.once('SIGINT', async () => {
      this.logger.log('SIGINT signal received: disconnecting Prisma client...');
      await this.onModuleDestroy();
    });

    const maxRetries = 5;
    let delayMs = 1000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.$connect();
        if (this.replicaClient) {
          await this.replicaClient.$connect();
          this.logger.log('Read-replica connection established');
        }
        this.logger.log('Database connection established');
        this.logger.log(
          `Prisma connection pool configured: connection_limit=${this.poolConfig.connectionLimit}, ` +
          `pool_timeout=${this.poolConfig.poolTimeout}s, connect_timeout=${this.poolConfig.connectTimeout}s`,
        );
        return;

      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Database connection attempt ${attempt}/${maxRetries} failed: ${errorMsg}`,
        );
        if (attempt === maxRetries) {
          this.logger.error('All database connection retries exhausted');
          throw err;
        }
        this.logger.log(`Retrying in ${delayMs / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs *= 2;
      }
    }
  }

  async onModuleDestroy() {
    const retiring = [...this.retiring.entries()];
    this.retiring.clear();
    for (const [timer] of retiring) clearTimeout(timer);
    await this.disconnectQuietly(retiring.flatMap(([, clients]) => clients));

    await this.$disconnect();
    if (this.replicaClient) {
      await this.replicaClient.$disconnect();
    }
    this.logger.log('Database connection closed');
  }

  /**
   * Runs `queryFn` and caches its result in-process under `key` for
   * `ttlSeconds` (default 30s). Repeated calls with the same key return the
   * cached value without hitting the database until it expires.
   *
   * Intended for frequently-read, rarely-changing data (e.g. product
   * definitions, config-style lookups) — not for data that must always be
   * fresh, and never for writes.
   *
   * @example
   *   const product = await this.prisma.cachedQuery(
   *     `product:${productId}`,
   *     60,
   *     () => this.prisma.reader.product.findUnique({ where: { id: productId } }),
   *   );
   */
  async cachedQuery<T>(
    key: string,
    ttlSeconds: number = DEFAULT_QUERY_CACHE_TTL_SECONDS,
    queryFn: () => Promise<T>,
  ): Promise<T> {
    const cached = this.queryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as T;
    }

    const value = await queryFn();
    this.queryCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return value;
  }

  /**
   * Invalidates a single cached entry, e.g. after a write that changes the
   * data behind that key. No-op if the key isn't cached.
   */
  invalidateCache(key: string): void {
    this.queryCache.delete(key);
  }

  /**
   * Invalidates every cached entry whose key starts with `prefix`. Useful
   * for invalidating a family of keys (e.g. all `product:*` entries) after a
   * bulk update.
   */
  invalidateCacheByPrefix(prefix: string): void {
    for (const key of this.queryCache.keys()) {
      if (key.startsWith(prefix)) {
        this.queryCache.delete(key);
      }
    }
  }

  /**
   * Expose Prisma internal engine pool metrics if supported by the installed
   * Prisma engine/client (#676). Returns null if metrics preview is unavailable.
   */
  async getMetrics(): Promise<unknown | null> {
    try {
      if (typeof (this.client as any).$metrics?.json === 'function') {
        return await (this.client as any).$metrics.json();
      }
    } catch (err) {
      this.logger.warn(`Failed to collect Prisma metrics: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}

