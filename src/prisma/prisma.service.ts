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

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  // #439 — Read replica client. Instantiated only when DATABASE_REPLICA_URL
  // is set; otherwise reader falls back to the primary so callers need no
  // conditional logic and existing code paths are unchanged.
  private readonly replicaClient: PrismaClient | null;

  // In-process TTL cache for repeated read queries (e.g. product lookups,
  // config-style tables) that are hit frequently but change rarely. Callers
  // opt in explicitly via `cachedQuery`; nothing is cached implicitly, so
  // writes and transactions are never affected.
  private readonly queryCache = new Map<string, CacheEntry>();

  constructor() {
    super({ datasourceUrl: withConnectionPoolParams(process.env.DATABASE_URL) });

    const replicaUrl = withConnectionPoolParams(process.env.DATABASE_REPLICA_URL);
    this.replicaClient = replicaUrl
      ? new PrismaClient({ datasourceUrl: replicaUrl })
      : null;
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

  async onModuleInit() {
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
}
