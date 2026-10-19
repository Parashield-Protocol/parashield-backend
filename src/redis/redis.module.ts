import { Module, Global, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { DistributedLockService } from './distributed-lock.service';
import { RedisConnectionService } from './redis-connection.service';
import { RedisStartupRetryOptions, readRedisStartupRetryOptions } from './redis-startup';

const redisLogger = new Logger('RedisClient');

/**
 * Attach an error listener to the client so a connection error can never
 * surface as an unhandled 'error' event (which would crash the process).
 * Idempotent: a second call is a no-op.
 */
export function registerRedisErrorHandler(client: Redis): void {
  const holder = client as unknown as { __parashieldErrorHandlerAttached?: boolean };
  if (holder.__parashieldErrorHandlerAttached) return;
  holder.__parashieldErrorHandlerAttached = true;
  // The message is safe to log — it never contains credentials.
  client.on('error', (err: Error) => {
    redisLogger.warn(`Redis client error: ${err?.message ?? String(err)}`);
  });
}

/**
 * Create the single shared Redis client.
 *
 * `lazyConnect` keeps construction non-blocking; the actual startup connect
 * (with retries) is performed by RedisConnectionService.onModuleInit.
 *
 * `retryStrategy` returns `null` until startup completes, so ioredis does not
 * schedule background reconnects that would race the startup loop. Once
 * connected, RedisConnectionService swaps in {@link runtimeRetryDelay} and
 * ioredis owns runtime reconnection.
 */
export function createRedisClient(
  redisUrl: string,
  options: RedisStartupRetryOptions,
): Redis {
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy: () => null,
    // Reconnect with backoff on connection loss once startup has completed.
    reconnectOnError(err: Error) {
      const target = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
      return target.some((code) => err.message.includes(code));
    },
    // Keep connections alive to detect stale connections early.
    keepAlive: 10000,
    // Per-attempt connection timeout: a hung connect cannot stall startup.
    connectTimeout: options.attemptTimeoutMs,
  });

  registerRedisErrorHandler(client);
  return client;
}

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.get<string>('REDIS_URL');
        if (!redisUrl) {
          throw new Error('REDIS_URL environment variable is required');
        }
        const options = readRedisStartupRetryOptions(
          (key) => configService.get<string>(key) ?? undefined,
        );
        return createRedisClient(redisUrl, options);
      },
      inject: [ConfigService],
    },
    RedisConnectionService,
    DistributedLockService,
  ],
  exports: ['REDIS_CLIENT', DistributedLockService],
})
export class RedisModule {}
