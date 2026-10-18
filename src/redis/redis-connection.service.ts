import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import {
  ConnectRetryDeps,
  ConnectRetryLogger,
  RedisTarget,
  connectWithRetry,
  parseRedisTarget,
  readRedisStartupRetryOptions,
} from './redis-startup';

/**
 * Runtime reconnection strategy handed to ioredis once startup succeeds.
 * Kept identical to the pre-#710 behaviour: exponential-ish backoff capped at
 * 2s. During startup the strategy is `null` (set in redis.module.ts) so it does
 * not race {@link connectWithRetry}.
 */
export function runtimeRetryDelay(times: number): number {
  return Math.min(times * 200, 2_000);
}

/**
 * RedisConnectionService (#710)
 *
 * Owns the startup handshake for the shared `REDIS_CLIENT`:
 *  - retries the first connection with backoff/jitter/timeout
 *  - fails startup with one actionable error after the configured attempts
 *  - hands runtime reconnection back to ioredis once connected
 *  - closes the client on shutdown (idempotently)
 *
 * It never creates a client itself — the single instance is provided by
 * RedisModule's `REDIS_CLIENT` factory.
 */
@Injectable()
export class RedisConnectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisConnectionService.name);
  private closed = false;

  constructor(
    @Inject('REDIS_CLIENT') private readonly client: Redis,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const options = readRedisStartupRetryOptions(
      (key) => this.config.get<string>(key) ?? undefined,
    );
    const target: RedisTarget = parseRedisTarget(this.config.get<string>('REDIS_URL'));

    await connectWithRetry(this.client, options, target, this.retryDeps(), this.retryLogger());
    this.enableRuntimeReconnect();

    this.logger.log(
      `Redis connected at ${target.host}:${target.port} (startup retry: up to ${options.maxAttempts} attempts)`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.closeClient();
  }

  /** Resume ioredis-owned runtime reconnection now that startup is complete. */
  private enableRuntimeReconnect(): void {
    const client = this.client as unknown as { options?: Record<string, unknown> };
    if (client?.options) {
      client.options.retryStrategy = runtimeRetryDelay;
    }
  }

  private async closeClient(): Promise<void> {
    if (!this.client) return;
    const client = this.client as unknown as {
      status?: string;
      quit?: () => Promise<unknown>;
      disconnect?: (reconnect?: boolean) => void;
    };
    try {
      if (typeof client.quit === 'function' && client.status === 'ready') {
        await client.quit();
      } else if (typeof client.disconnect === 'function') {
        client.disconnect(false);
      }
    } catch (err) {
      this.logger.warn(
        `Error closing Redis client: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Injectable for tests (no real sleeps). */
  protected sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /** Injectable for tests. */
  protected now(): number {
    return Date.now();
  }

  /** Injectable for tests. */
  protected random(): number {
    return Math.random();
  }

  private retryDeps(): ConnectRetryDeps {
    return {
      sleep: (ms) => this.sleep(ms),
      now: () => this.now(),
      random: () => this.random(),
    };
  }

  private retryLogger(): ConnectRetryLogger {
    return {
      warn: (message) => this.logger.warn(message),
    };
  }
}
