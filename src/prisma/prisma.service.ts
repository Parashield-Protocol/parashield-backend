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

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({ datasourceUrl: withConnectionPoolParams(process.env.DATABASE_URL) });
  }

  async onModuleInit() {
    const maxRetries = 5;
    let delayMs = 1000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.$connect();
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
    this.logger.log('Database connection closed');
  }
}
