import { Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { EnvConfig } from '../env.schema';

const REQUEST_TIMEOUT_MS = 1000;

@Module({
  providers: [
    {
      provide: Redis,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>): Redis => {
        const client = new Redis({
          host: config.get('REDIS_HOST', { infer: true }),
          port: config.get('REDIS_PORT', { infer: true }),
          connectTimeout: REQUEST_TIMEOUT_MS,
          commandTimeout: REQUEST_TIMEOUT_MS,
          maxRetriesPerRequest: 1,
        });
        client.on('error', () => undefined);
        return client;
      },
    },
  ],
  exports: [Redis],
})
export class RedisModule implements OnModuleDestroy {
  constructor(private readonly redis: Redis) {}

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}
