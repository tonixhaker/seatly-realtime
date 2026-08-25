import { Injectable, Logger } from '@nestjs/common';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import Redis from 'ioredis';
import { SeatEventsService } from '../events/seat-events.service';
import { HoldStoreService } from '../holds/hold-store.service';
import { CONSUMED_TTL_SECONDS, consumedKey } from '../redis/keys';
import { SoldCacheService } from '../sold/sold-cache.service';
import { EventPublished } from './events/event.published';
import { OrderPaid } from './events/order.paid';
import { OrderPaymentFailed } from './events/order.payment_failed';
import { SeatlyEventEnvelope } from './events/envelope';
import { TicketsIssued } from './events/tickets.issued';
import envelopeSchema from './schemas/envelope.json';
import eventPublishedSchema from './schemas/event.published.json';
import orderPaidSchema from './schemas/order.paid.json';
import orderPaymentFailedSchema from './schemas/order.payment_failed.json';
import ticketsIssuedSchema from './schemas/tickets.issued.json';

export type ConsumedEvent =
  EventPublished | OrderPaid | OrderPaymentFailed | TicketsIssued;

export type HandleOutcome =
  | { status: 'ok'; eventId: string }
  | { status: 'duplicate'; eventId: string }
  | { status: 'malformed'; reason: string }
  | { status: 'failed'; eventId: string; reason: string };

const SCHEMAS = [
  eventPublishedSchema,
  orderPaidSchema,
  orderPaymentFailedSchema,
  ticketsIssuedSchema,
];

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error';

@Injectable()
export class ConsumerService {
  private readonly logger = new Logger(ConsumerService.name);
  private readonly validators = new Map<
    string,
    ValidateFunction<ConsumedEvent>
  >();

  constructor(
    private readonly redis: Redis,
    private readonly sold: SoldCacheService,
    private readonly store: HoldStoreService,
    private readonly seatEvents: SeatEventsService,
  ) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    ajv.addSchema(envelopeSchema);

    for (const schema of SCHEMAS) {
      this.validators.set(
        schema.properties.event_type.const,
        ajv.compile<ConsumedEvent>(schema),
      );
    }
  }

  async handle(raw: Buffer): Promise<HandleOutcome> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      return {
        status: 'malformed',
        reason: `unparseable json: ${reasonOf(error)}`,
      };
    }

    const type = (parsed as Partial<SeatlyEventEnvelope> | null)?.event_type;
    const validate =
      typeof type === 'string' ? this.validators.get(type) : undefined;

    if (validate === undefined) {
      return {
        status: 'malformed',
        reason: `no schema for event_type ${JSON.stringify(type)}`,
      };
    }

    if (!validate(parsed)) {
      return {
        status: 'malformed',
        reason: (validate.errors ?? [])
          .map(
            (e) => `${e.instancePath || '/'} ${e.keyword} ${e.message ?? ''}`,
          )
          .join('; '),
      };
    }

    const message = parsed;
    const eventId = message.event_id;

    try {
      if ((await this.redis.exists(consumedKey(eventId))) === 1) {
        return { status: 'duplicate', eventId };
      }

      await this.dispatch(message);
      await this.redis.set(
        consumedKey(eventId),
        '',
        'EX',
        CONSUMED_TTL_SECONDS,
      );
    } catch (error) {
      return { status: 'failed', eventId, reason: reasonOf(error) };
    }

    return { status: 'ok', eventId };
  }

  private async dispatch(message: ConsumedEvent): Promise<void> {
    if (message.event_type === 'event.published') {
      await this.sold.markPublished(
        message.payload.event_id,
        message.payload.seat_ids,
      );
      return;
    }

    if (message.event_type === 'order.paid') {
      const { event_id: eventId, seat_ids: seatIds } = message.payload;

      await this.sold.markSold(eventId, seatIds);
      await this.store.forceRelease({ eventId, seatIds });
      this.seatEvents.emitSold(eventId, seatIds);
      return;
    }

    if (message.event_type === 'order.payment_failed') {
      this.logger.log(
        `order.payment_failed for order ${message.payload.order_id}: holds left alive`,
      );
    }
  }
}
