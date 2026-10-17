import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { DistributedLockService } from './distributed-lock.service';

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
        return new Redis(redisUrl, {
          // Retry configuration for transient connection failures (#664).
          maxRetriesPerRequest: 3,
          retryStrategy(times: number) {
            const delay = Math.min(times * 200, 2000);
            return delay;
          },
          // Reconnect with exponential backoff on connection loss.
          reconnectOnError(err: Error) {
            const target = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
            return target.some((code) => err.message.includes(code));
          },
          // Keep connections alive to detect stale connections early.
          keepAlive: 10000,
          // Connection timeout to fail fast on unreachable hosts.
          connectTimeout: 5000,
        });
      },
      inject: [ConfigService],
    },
    DistributedLockService,
  ],
  exports: ['REDIS_CLIENT', DistributedLockService],
})
export class RedisModule {}

