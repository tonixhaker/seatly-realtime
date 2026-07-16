import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Channel, ChannelModel, connect } from 'amqplib';
import Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { ConsumerModule } from '../src/consumer/consumer.module';
import { CONSUMER_TOPOLOGY } from '../src/consumer/topology';
import { SeatEventsService } from '../src/events/seat-events.service';
import { validateEnv } from '../src/env.schema';
import { HoldStoreService } from '../src/holds/hold-store.service';
import { HoldsModule } from '../src/holds/holds.module';
import { HttpExceptionFilter } from '../src/http-exception.filter';
import { SoldCacheService } from '../src/sold/sold-cache.service';
import { CoreStub } from './support/core-stub';
import {
  deleteTopology,
  throwawayTopology,
} from './support/throwaway-topology';

jest.setTimeout(30000);

const BASE_EVENT_ID = 300000 + Math.floor(Math.random() * 80000);

const EXCHANGE_KIND = 'topic';

const WAIT_TIMEOUT_MS = 8000;

const WAIT_INTERVAL_MS = 25;

const topology = throwawayTopology('consumer');

let failingEventId: number | null = null;

let markSoldCalls = 0;

class FlakySoldCache extends SoldCacheService {
  async markSold(eventId: number, seatIds: number[]): Promise<void> {
    markSoldCalls += 1;

    if (eventId === failingEventId) {
      throw new Error('redis is briefly unavailable');
    }

    await super.markSold(eventId, seatIds);
  }
}

const envelopeFor = (
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> => ({
  event_id: randomUUID(),
  event_type: eventType,
  occurred_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  version: 1,
  payload,
});

const orderPaid = (eventId: number, seatIds: number[]) =>
  envelopeFor('order.paid', {
    order_id: randomUUID(),
    event_id: eventId,
    seat_ids: seatIds,
    buyer_id: 4,
  });

const paymentFailed = (eventId: number, seatIds: number[], sessionId: string) =>
  envelopeFor('order.payment_failed', {
    order_id: randomUUID(),
    event_id: eventId,
    seat_ids: seatIds,
    session_id: sessionId,
  });

const eventPublished = (eventId: number, seatIds: number[]) =>
  envelopeFor('event.published', { event_id: eventId, seat_ids: seatIds });

describe('RabbitMQ consumer (e2e)', () => {
  let app: INestApplication<App>;
  let redis: Redis;
  let model: ChannelModel;
  let channel: Channel;
  let store: HoldStoreService;
  let seatEvents: SeatEventsService;
  let core: CoreStub;
  let eventId: number;
  let nextEventId = BASE_EVENT_ID;
  let soldEmits: number;
  const publishedIds: string[] = [];
  const touchedEvents: number[] = [];
  const touchedSessions: string[] = [];

  const http = () => app.getHttpServer();

  const waitFor = async (
    what: string,
    probe: () => Promise<unknown>,
    ready: (value: unknown) => boolean,
  ): Promise<unknown> => {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    let last: unknown;

    while (Date.now() < deadline) {
      last = await probe();

      if (ready(last)) {
        return last;
      }

      await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
    }

    throw new Error(
      `${what} never became true within ${String(WAIT_TIMEOUT_MS)}ms; ` +
        `last observed value was ${JSON.stringify(last)}. The consumer either ` +
        'never received the message or never finished handling it.',
    );
  };

  const publish = (
    routingKey: string,
    envelope: Record<string, unknown>,
  ): string => {
    const id = envelope.event_id as string;

    publishedIds.push(id);
    channel.publish(
      topology.exchange,
      routingKey,
      Buffer.from(JSON.stringify(envelope)),
      { contentType: 'application/json', deliveryMode: 2, messageId: id },
    );

    return id;
  };

  const publishRaw = (routingKey: string, body: string): void => {
    channel.publish(topology.exchange, routingKey, Buffer.from(body), {
      contentType: 'application/json',
      deliveryMode: 2,
      messageId: randomUUID(),
    });
  };

  const awaitConsumed = (id: string) =>
    waitFor(
      `consumed:${id} to be written`,
      () => redis.exists(`consumed:${id}`),
      (value) => value === 1,
    );

  const depthOf = async (queue: string): Promise<number> => {
    const probe = await model.createChannel();

    probe.on('error', () => undefined);

    const state = await probe.checkQueue(queue);

    await probe.close().catch(() => undefined);

    return state.messageCount;
  };

  const hold = async (
    event: number,
    seatIds: number[],
    sessionId: string,
  ): Promise<void> => {
    touchedSessions.push(sessionId);
    const outcome = await store.acquire({ eventId: event, seatIds, sessionId });

    expect(outcome.ok).toBe(true);
  };

  beforeAll(async () => {
    core = new CoreStub();
    const coreUrl = await core.start();

    const env = {
      PORT: '3000',
      INTERNAL_TOKEN: 'e2e-internal-token',
      REDIS_HOST: process.env.REDIS_HOST as string,
      REDIS_PORT: process.env.REDIS_PORT as string,
      RABBITMQ_URL: process.env.RABBITMQ_URL as string,
      CORE_API_URL: coreUrl,
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          validate: () => validateEnv(env),
        }),
        ConsumerModule,
        HoldsModule,
      ],
    })
      .overrideProvider(CONSUMER_TOPOLOGY)
      .useValue(topology)
      .overrideProvider(SoldCacheService)
      .useFactory({
        factory: (client: Redis, config: ConfigService) =>
          new FlakySoldCache(client, config),
        inject: [Redis, ConfigService],
      })
      .compile();

    app = moduleRef.createNestApplication<App>();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    store = app.get(HoldStoreService);
    seatEvents = app.get(SeatEventsService);
    seatEvents.onSold(() => {
      soldEmits += 1;
    });

    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
    });

    model = await connect(process.env.RABBITMQ_URL as string);
    model.on('error', () => undefined);
    channel = await model.createChannel();
    channel.on('error', () => undefined);

    await waitFor(
      `the consumer to declare ${topology.queue}`,
      async () => {
        const probe = await model.createChannel();

        probe.on('error', () => undefined);

        const found = await probe
          .checkQueue(topology.queue)
          .then(() => true)
          .catch(() => false);

        await probe.close().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 100));

        return found;
      },
      (value) => value === true,
    );
  });

  beforeEach(() => {
    eventId = ++nextEventId;
    touchedEvents.push(eventId);
    soldEmits = 0;
    markSoldCalls = 0;
    failingEventId = null;
    core.answer('empty');
  });

  afterEach(async () => {
    const keys = [
      ...(await redis.keys(`hold:${eventId}:*`)),
      ...(await redis.keys(`expiry:*:${eventId}:*`)),
      `sold:${eventId}`,
      `sold-warm:${eventId}`,
    ];

    await redis.del(...keys);
  });

  afterAll(async () => {
    const leftovers = [
      ...publishedIds.map((id) => `consumed:${id}`),
      ...touchedSessions.map((id) => `session:${id}`),
    ];

    for (const event of touchedEvents) {
      leftovers.push(
        `sold:${event}`,
        `sold-warm:${event}`,
        ...(await redis.keys(`hold:${event}:*`)),
        ...(await redis.keys(`expiry:*:${event}:*`)),
      );
    }

    if (leftovers.length > 0) {
      await redis.del(...leftovers);
    }

    await channel.close().catch(() => undefined);
    await model.close().catch(() => undefined);
    await redis.quit();
    await app.close();
    await core.stop();
    await deleteTopology(topology);
  });

  describe('order.paid', () => {
    it('marks exactly the paid seats sold and releases exactly their holds', async () => {
      const mine = randomUUID();
      const theirs = randomUUID();

      await hold(eventId, [1, 2], mine);
      await hold(eventId, [3], theirs);

      const id = publish('order.paid', orderPaid(eventId, [1, 3]));

      await awaitConsumed(id);

      expect((await redis.smembers(`sold:${eventId}`)).sort()).toEqual([
        '1',
        '3',
      ]);
      expect(await redis.exists(`hold:${eventId}:1`)).toBe(0);
      expect(await redis.exists(`hold:${eventId}:3`)).toBe(0);
      expect(await redis.exists(`hold:${eventId}:2`)).toBe(1);
      expect(await redis.exists(`expiry:${mine}:${eventId}:1`)).toBe(0);
      expect(await redis.exists(`expiry:${theirs}:${eventId}:3`)).toBe(0);
      expect(await redis.exists(`expiry:${mine}:${eventId}:2`)).toBe(1);
      expect(await redis.sismember(`session:${mine}`, `${eventId}:1`)).toBe(0);
      expect(await redis.sismember(`session:${mine}`, `${eventId}:2`)).toBe(1);
      expect(await redis.sismember(`session:${theirs}`, `${eventId}:3`)).toBe(
        0,
      );
    });

    it('reports the new state through live-seats, a reader it does not share code with', async () => {
      const mine = randomUUID();

      await hold(eventId, [1, 2], mine);

      const id = publish('order.paid', orderPaid(eventId, [1]));

      await awaitConsumed(id);

      const response = await request(http())
        .get(`/events/${String(eventId)}/live-seats`)
        .expect(200);

      expect(response.body).toEqual({ held: [2], sold: [1] });
    });

    it('acks the message rather than leaving it queued or dead-lettering it', async () => {
      const id = publish('order.paid', orderPaid(eventId, [5]));

      await awaitConsumed(id);

      expect(await depthOf(topology.queue)).toBe(0);
      expect(await depthOf(topology.deadLetterQueue)).toBe(0);
    });
  });

  describe('the same order.paid delivered twice', () => {
    it('broadcasts once, and the second delivery releases nothing it finds', async () => {
      const mine = randomUUID();
      const later = randomUUID();

      await hold(eventId, [1], mine);

      const envelope = orderPaid(eventId, [1]);
      const id = publish('order.paid', envelope);

      await awaitConsumed(id);
      expect(soldEmits).toBe(1);

      await hold(eventId, [1], later);

      publishedIds.push(envelope.event_id as string);
      channel.publish(
        topology.exchange,
        'order.paid',
        Buffer.from(JSON.stringify(envelope)),
        {
          contentType: 'application/json',
          deliveryMode: 2,
          messageId: envelope.event_id as string,
        },
      );

      await waitFor(
        'the redelivered message to be acked',
        () => depthOf(topology.queue),
        (value) => value === 0,
      );

      expect(soldEmits).toBe(1);
      expect(await redis.exists(`hold:${eventId}:1`)).toBe(1);
      expect(await depthOf(topology.deadLetterQueue)).toBe(0);
    });

    it('processes two envelopes that carry the same payload under different event_ids', async () => {
      const first = publish('order.paid', orderPaid(eventId, [7]));
      const second = publish('order.paid', orderPaid(eventId, [7]));

      await awaitConsumed(first);
      await awaitConsumed(second);
      await waitFor(
        'both messages to be acked',
        () => depthOf(topology.queue),
        (value) => value === 0,
      );

      expect(soldEmits).toBe(2);
    });
  });

  describe('order.payment_failed', () => {
    it('leaves every hold, companion and session member intact and sells nothing', async () => {
      const mine = randomUUID();

      await hold(eventId, [1, 2], mine);

      const id = publish(
        'order.payment_failed',
        paymentFailed(eventId, [1, 2], mine),
      );

      await awaitConsumed(id);

      expect(await redis.exists(`hold:${eventId}:1`)).toBe(1);
      expect(await redis.exists(`hold:${eventId}:2`)).toBe(1);
      expect(await redis.exists(`expiry:${mine}:${eventId}:1`)).toBe(1);
      expect(await redis.exists(`expiry:${mine}:${eventId}:2`)).toBe(1);
      expect(await redis.smembers(`session:${mine}`)).toHaveLength(2);
      expect(await redis.exists(`sold:${eventId}`)).toBe(0);
      expect(soldEmits).toBe(0);
    });

    it('acks the message instead of dead-lettering it', async () => {
      const mine = randomUUID();
      const id = publish(
        'order.payment_failed',
        paymentFailed(eventId, [1], mine),
      );

      await awaitConsumed(id);

      expect(await depthOf(topology.queue)).toBe(0);
      expect(await depthOf(topology.deadLetterQueue)).toBe(0);
    });
  });

  describe('event.published', () => {
    it('warms the cache so live-seats never calls core', async () => {
      core.answer('ok');
      const before = core.callCount;

      const id = publish('event.published', eventPublished(eventId, [1, 2, 3]));

      await awaitConsumed(id);

      const response = await request(http())
        .get(`/events/${String(eventId)}/live-seats`)
        .expect(200);

      expect(response.body).toEqual({ held: [], sold: [] });
      expect(core.callCount).toBe(before);
    });

    it('leaves the warm marker expiring, so a dropped order.paid still repairs itself', async () => {
      const id = publish('event.published', eventPublished(eventId, [1]));

      await awaitConsumed(id);

      const ttl = await redis.ttl(`sold-warm:${eventId}`);

      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
      expect(await redis.exists(`sold:${eventId}`)).toBe(0);
    });
  });

  describe('tickets.issued', () => {
    it('never reaches the queue, because order.* must not be widened to cover it', async () => {
      const ticket = publish(
        'tickets.issued',
        envelopeFor('tickets.issued', {
          order_id: randomUUID(),
          ticket_ids: [randomUUID()],
        }),
      );

      const settle = publish('order.paid', orderPaid(eventId, [9]));

      await awaitConsumed(settle);

      expect(await redis.exists(`consumed:${ticket}`)).toBe(0);
      expect(await depthOf(topology.queue)).toBe(0);
      expect(await depthOf(topology.deadLetterQueue)).toBe(0);
      expect(markSoldCalls).toBe(1);
    });
  });

  describe('failure handling', () => {
    it('dead-letters after exactly three attempts and keeps the queue moving', async () => {
      failingEventId = eventId;

      const envelope = orderPaid(eventId, [1]);
      const id = publish('order.paid', envelope);

      await waitFor(
        'the poison message to reach the dead-letter queue',
        () => depthOf(topology.deadLetterQueue),
        (value) => value === 1,
      );

      expect(markSoldCalls).toBe(3);
      expect(await redis.exists(`consumed:${id}`)).toBe(0);

      const next = ++nextEventId;

      touchedEvents.push(next);

      const good = publish('order.paid', orderPaid(next, [4]));

      await awaitConsumed(good);

      expect(await redis.smembers(`sold:${next}`)).toEqual(['4']);
      expect(await depthOf(topology.queue)).toBe(0);

      const dead = await channel.get(topology.deadLetterQueue, { noAck: true });

      expect(dead).not.toBe(false);

      if (dead !== false) {
        expect(JSON.parse(dead.content.toString())).toEqual(envelope);
      }
    });

    it('dead-letters a malformed payload on the first attempt, never reaching a handler', async () => {
      failingEventId = eventId;

      const envelope = orderPaid(eventId, [1]) as {
        payload: Record<string, unknown>;
      };

      envelope.payload.refund_cents = 100;

      publishRaw('order.paid', JSON.stringify(envelope));

      await waitFor(
        'the malformed message to reach the dead-letter queue',
        () => depthOf(topology.deadLetterQueue),
        (value) => value === 1,
      );

      expect(markSoldCalls).toBe(0);

      await channel.get(topology.deadLetterQueue, { noAck: true });
    });

    it('dead-letters an occurred_at with no offset, which the PHP producer would have accepted', async () => {
      const envelope = orderPaid(eventId, [1]);

      envelope.occurred_at = '2026-10-01T18:42:11';

      publishRaw('order.paid', JSON.stringify(envelope));

      await waitFor(
        'the offset-less message to reach the dead-letter queue',
        () => depthOf(topology.deadLetterQueue),
        (value) => value === 1,
      );

      expect(markSoldCalls).toBe(0);

      await channel.get(topology.deadLetterQueue, { noAck: true });
    });

    it('dead-letters bytes that are not json at all', async () => {
      publishRaw('order.paid', 'this is not json');

      await waitFor(
        'the unparseable message to reach the dead-letter queue',
        () => depthOf(topology.deadLetterQueue),
        (value) => value === 1,
      );

      expect(markSoldCalls).toBe(0);

      await channel.get(topology.deadLetterQueue, { noAck: true });
    });

    it('dead-letters an unknown event_type rather than falling back to the open envelope', async () => {
      publishRaw(
        'order.refunded',
        JSON.stringify(envelopeFor('order.refunded', { anything: true })),
      );

      await waitFor(
        'the unknown type to reach the dead-letter queue',
        () => depthOf(topology.deadLetterQueue),
        (value) => value === 1,
      );

      expect(markSoldCalls).toBe(0);

      await channel.get(topology.deadLetterQueue, { noAck: true });
    });
  });

  describe('the exchange contract with seatly-api', () => {
    it('is declared durable, so the producer cannot be locked out by a redeclaration', async () => {
      const probe = await model.createChannel();

      probe.on('error', () => undefined);

      await expect(
        probe.assertExchange(topology.exchange, EXCHANGE_KIND, {
          durable: false,
        }),
      ).rejects.toThrow(/PRECONDITION_FAILED/);
    });
  });
});
