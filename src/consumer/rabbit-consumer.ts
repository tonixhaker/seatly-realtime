import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Channel, ChannelModel, ConsumeMessage, connect } from 'amqplib';
import { PinoLogger, RunInContextOptions } from 'nestjs-pino';
import { EnvConfig } from '../env.schema';
import { REQUEST_ID } from '../logging';
import { ConsumerService } from './consumer.service';
import type { ConsumerTopology } from './topology';
import { CONSUMER_TOPOLOGY, MAX_ATTEMPTS } from './topology';

const SOCKET_TIMEOUT_MS = 2000;

const RECONNECT_DELAY_MS = 5000;

const BINDINGS = ['order.*', 'event.published'];

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error';

const contextOf = (message: ConsumeMessage): RunInContextOptions => {
  const header: unknown = message.properties.headers?.['x-request-id'];

  return typeof header === 'string' && REQUEST_ID.test(header)
    ? { bindings: { request_id: header } }
    : {};
};

@Injectable()
export class RabbitConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitConsumer.name);
  private readonly attempts = new Map<string, number>();
  private model: ChannelModel | undefined;
  private opening: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly config: ConfigService<EnvConfig, true>,
    private readonly consumer: ConsumerService,
    private readonly pino: PinoLogger,
    @Inject(CONSUMER_TOPOLOGY) private readonly topology: ConsumerTopology,
  ) {}

  onModuleInit(): void {
    this.opening = this.open();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;

    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    await this.opening?.catch(() => undefined);

    const model = this.model;
    this.model = undefined;
    await model?.close().catch(() => undefined);
  }

  private async open(): Promise<void> {
    if (this.stopped) {
      return;
    }

    let model: ChannelModel | undefined;

    try {
      model = await connect(this.config.get('RABBITMQ_URL', { infer: true }), {
        timeout: SOCKET_TIMEOUT_MS,
      });
      model.on('error', () => undefined);
      model.on('close', () => {
        this.model = undefined;
        this.schedule();
      });

      await this.declare(model);

      if (this.stopped) {
        await model.close().catch(() => undefined);
        return;
      }

      this.model = model;
      this.logger.log(`consuming ${this.topology.queue}`);
    } catch (error) {
      await model?.close().catch(() => undefined);
      this.logger.warn(
        `rabbitmq consumer is not connected: ${reasonOf(error)}`,
      );
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.stopped || this.timer !== undefined) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.opening = this.open();
    }, RECONNECT_DELAY_MS);

    this.timer.unref();
  }

  private async declare(model: ChannelModel): Promise<void> {
    const { exchange, queue, deadLetterQueue } = this.topology;
    const channel = await model.createChannel();

    await channel.assertExchange(exchange, 'topic', {
      durable: true,
      autoDelete: false,
    });
    await channel.assertQueue(deadLetterQueue, {
      durable: true,
      autoDelete: false,
      exclusive: false,
    });
    await channel.assertQueue(queue, {
      durable: true,
      autoDelete: false,
      exclusive: false,
      deadLetterExchange: '',
      deadLetterRoutingKey: deadLetterQueue,
    });

    for (const binding of BINDINGS) {
      await channel.bindQueue(queue, exchange, binding);
    }

    await channel.prefetch(1);
    await channel.consume(
      queue,
      (message) => {
        if (message !== null) {
          void this.pino.runInContext(
            () => this.onMessage(channel, message),
            contextOf(message),
          );
        }
      },
      { noAck: false },
    );
  }

  private async onMessage(
    channel: Channel,
    message: ConsumeMessage,
  ): Promise<void> {
    const routingKey = message.fields.routingKey;

    this.logger.log(
      `received ${routingKey} ${String(message.properties.messageId)}`,
    );

    const outcome = await this.consumer.handle(message.content);

    if (outcome.status === 'ok' || outcome.status === 'duplicate') {
      this.attempts.delete(outcome.eventId);
      this.logger.log(
        outcome.status === 'ok'
          ? `applied ${routingKey} ${outcome.eventId}`
          : `skipped duplicate ${routingKey} ${outcome.eventId}`,
      );
      channel.ack(message);
      return;
    }

    if (outcome.status === 'malformed') {
      this.logger.error(
        `dead-lettering a malformed message ${String(message.properties.messageId)}: ${outcome.reason}`,
      );
      channel.nack(message, false, false);
      return;
    }

    const attempt = (this.attempts.get(outcome.eventId) ?? 0) + 1;

    if (attempt >= MAX_ATTEMPTS) {
      this.attempts.delete(outcome.eventId);
      this.logger.error(
        `dead-lettering ${outcome.eventId} after ${String(MAX_ATTEMPTS)} attempts: ${outcome.reason}`,
      );
      channel.nack(message, false, false);
      return;
    }

    this.attempts.set(outcome.eventId, attempt);
    this.logger.warn(
      `attempt ${String(attempt)} of ${String(MAX_ATTEMPTS)} failed for ${outcome.eventId}: ${outcome.reason}`,
    );
    channel.nack(message, false, true);
  }
}
