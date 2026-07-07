import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { EXPIRED_CHANNEL, parseExpiryKey } from '../redis/keys';
import { HoldStoreService } from '../holds/hold-store.service';

export const EXPIRY_CONNECTION_NAME = 'seatly-expiry';

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error';

@Injectable()
export class ExpiryService implements OnModuleDestroy {
  private readonly logger = new Logger(ExpiryService.name);
  private readonly subscriber: Redis;

  constructor(
    redis: Redis,
    private readonly store: HoldStoreService,
  ) {
    this.subscriber = redis.duplicate({
      commandTimeout: undefined,
      connectionName: EXPIRY_CONNECTION_NAME,
    });
    this.subscriber.on('error', () => undefined);
    this.subscriber.on('message', (_channel: string, key: string) => {
      void this.handle(key);
    });
    this.subscriber.on('ready', () => {
      this.subscriber
        .subscribe(EXPIRED_CHANNEL)
        .catch((error: unknown) =>
          this.logger.warn(`expiry subscription failed: ${reasonOf(error)}`),
        );
    });
  }

  onModuleDestroy(): void {
    this.subscriber.disconnect();
  }

  async handle(key: string): Promise<void> {
    const expired = parseExpiryKey(key);

    if (expired === null) {
      return;
    }

    try {
      await this.store.forgetExpired(expired);
    } catch (error) {
      this.logger.warn(`expiry cleanup failed for ${key}: ${reasonOf(error)}`);
    }
  }
}
