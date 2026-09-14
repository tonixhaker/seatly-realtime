import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelModel, connect } from 'amqplib';
import Redis from 'ioredis';
import { EnvConfig } from '../env.schema';

export type CheckState = 'ok' | 'error';

export interface ReadinessReport {
  status: CheckState;
  checks: { redis: CheckState; rabbitmq: CheckState };
}

const PROBE_TIMEOUT_MS = 1000;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error';

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);
  private readonly redis: Redis;

  constructor(private readonly config: ConfigService<EnvConfig, true>) {
    this.redis = new Redis({
      host: this.config.get('REDIS_HOST', { infer: true }),
      port: this.config.get('REDIS_PORT', { infer: true }),
      connectTimeout: PROBE_TIMEOUT_MS,
      commandTimeout: PROBE_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
    });
    this.redis.on('error', () => undefined);
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  async check(): Promise<ReadinessReport> {
    const [redis, rabbitmq] = await Promise.all([
      this.pingRedis(),
      this.pingRabbitmq(),
    ]);

    return {
      status: redis === 'ok' && rabbitmq === 'ok' ? 'ok' : 'error',
      checks: { redis, rabbitmq },
    };
  }

  private async pingRedis(): Promise<CheckState> {
    try {
      await this.redis.ping();
      return 'ok';
    } catch (error) {
      this.logger.warn(`redis readiness check failed: ${reasonOf(error)}`);
      return 'error';
    }
  }

  private async pingRabbitmq(): Promise<CheckState> {
    let connection: ChannelModel | undefined;

    try {
      connection = await connect(
        this.config.get('RABBITMQ_URL', { infer: true }),
        { timeout: PROBE_TIMEOUT_MS },
      );
      connection.on('error', () => undefined);
      return 'ok';
    } catch (error) {
      this.logger.warn(`rabbitmq readiness check failed: ${reasonOf(error)}`);
      return 'error';
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }
}
