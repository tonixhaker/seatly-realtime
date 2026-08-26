import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Channel, ChannelModel, connect } from 'amqplib';
import Redis from 'ioredis';
import { Logger } from 'nestjs-pino';
import request from 'supertest';
import { App } from 'supertest/types';
import { ConsumerModule } from '../src/consumer/consumer.module';
import { CONSUMER_TOPOLOGY } from '../src/consumer/topology';
import { SeatEventsService } from '../src/events/seat-events.service';
import { EnvConfig, validateEnv } from '../src/env.schema';
import { HoldStoreService } from '../src/holds/hold-store.service';
import { HoldsModule } from '../src/holds/holds.module';
import { HttpExceptionFilter } from '../src/http-exception.filter';
import { loggerModule } from '../src/logging';
import { SoldCacheService } from '../src/sold/sold-cache.service';
import { CoreStub } from './support/core-stub';
import { knownSeats } from './support/known-seats';
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

interface LogLine {
  level: number;
  msg: string;
  context?: string;
  request_id?: string;
}

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
  const captured: string[] = [];
  let stdout: jest.SpiedFunction<typeof process.stdout.write>;

  const http = () => app.getHttpServer();

  const logLines = (): LogLine[] =>
    captured
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as LogLine);

  const linesMentioning = (text: string): LogLine[] =>
    logLines().filter((line) => line.msg.includes(text));

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
    headers?: Record<string, unknown>,
  ): string => {
    const id = envelope.event_id as string;

    publishedIds.push(id);
    channel.publish(
      topology.exchange,
      routingKey,
      Buffer.from(JSON.stringify(envelope)),
      {
        contentType: 'application/json',
        deliveryMode: 2,
        messageId: id,
        headers,
      },
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
    await knownSeats(redis, event);
    const outcome = await store.acquire({ eventId: event, seatIds, sessionId });

    expect(outcome.ok).toBe(true);
  };

  const awaitLogged = (id: string, text: string) =>
    waitFor(
      `a "${text}" log line for ${id}`,
      () => Promise.resolve(linesMentioning(`${text} order.paid ${id}`).length),
      (value) => value === 1,
    );

  beforeAll(async () => {
    stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        captured.push(String(chunk));
        return true;
      });

    core = new CoreStub();
    const coreUrl = await core.start();

    const env = {
      PORT: '3000',
      INTERNAL_TOKEN: 'e2e-internal-token',
      REDIS_HOST: process.env.REDIS_HOST as string,
      REDIS_PORT: process.env.REDIS_PORT as string,
      RABBITMQ_URL: process.env.RABBITMQ_URL as string,
      CORE_API_URL: coreUrl,
      WEB_ORIGIN: process.env.WEB_ORIGIN as string,
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          validate: () => validateEnv(env),
        }),
        loggerModule,
        ConsumerModule,
        HoldsModule,
      ],
    })
      .overrideProvider(CONSUMER_TOPOLOGY)
      .useValue(topology)
      .overrideProvider(SoldCacheService)
      .useFactory({
        factory: (client: Redis, config: ConfigService<EnvConfig, true>) =>
          new FlakySoldCache(client, config),
        inject: [Redis, ConfigService],
      })
      .compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get(Logger));
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
      `seats:${eventId}`,
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
        `seats:${event}`,
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
    stdout.mockRestore();
  });

  describe('request id', () => {
    it('carries the x-request-id header on every line logged for the message', async () => {
      const requestId = randomUUID();
      const id = publish('order.paid', orderPaid(eventId, [1]), {
        'x-request-id': requestId,
      });

      await awaitLogged(id, 'applied');

      const lines = linesMentioning(id);

      expect(lines.map((line) => line.msg)).toEqual([
        `received order.paid ${id}`,
        `applied order.paid ${id}`,
      ]);
      expect(lines.every((line) => line.request_id === requestId)).toBe(true);
    });

    it('never lets one message log another message id, or an id when there is no header', async () => {
      const first = randomUUID();
      const second = randomUUID();
      const withFirst = publish('order.paid', orderPaid(eventId, [1]), {
        'x-request-id': first,
      });
      const without = publish('order.paid', orderPaid(eventId, [2]));
      const withSecond = publish('order.paid', orderPaid(eventId, [3]), {
        'x-request-id': second,
      });

      await awaitLogged(withSecond, 'applied');

      const idsOf = (id: string) =>
        linesMentioning(id).map((line) => line.request_id);

      expect(idsOf(withFirst)).toEqual([first, first]);
      expect(idsOf(without)).toEqual([undefined, undefined]);
      expect(
        linesMentioning(without).some((line) => 'request_id' in line),
      ).toBe(false);
      expect(idsOf(withSecond)).toEqual([second, second]);
    });

    it('processes a message whose header is not a uuid and never logs the value', async () => {
      const id = publish('order.paid', orderPaid(eventId, [1]), {
        'x-request-id': 'not-a-uuid',
      });

      await awaitConsumed(id);
      await awaitLogged(id, 'applied');

      expect(await redis.smembers(`sold:${eventId}`)).toEqual(['1']);
      expect(linesMentioning(id).some((line) => 'request_id' in line)).toBe(
        false,
      );
      expect(captured.join('')).not.toContain('not-a-uuid');
    });

    it('carries an uppercase uuid header verbatim', async () => {
      const requestId = randomUUID().toUpperCase();
      const id = publish('order.paid', orderPaid(eventId, [1]), {
        'x-request-id': requestId,
      });

      await awaitLogged(id, 'applied');

      expect(linesMentioning(id).map((line) => line.request_id)).toEqual([
        requestId,
        requestId,
      ]);
    });

    it('never logs a header that only contains a uuid inside a longer value', async () => {
      const inner = randomUUID();
      const padded = publish('order.paid', orderPaid(eventId, [1]), {
        'x-request-id': `${inner}${'a'.repeat(5000)}`,
      });
      const prefixed = publish('order.paid', orderPaid(eventId, [2]), {
        'x-request-id': ` ${inner}`,
      });

      await awaitLogged(padded, 'applied');
      await awaitLogged(prefixed, 'applied');

      expect(
        [...linesMentioning(padded), ...linesMentioning(prefixed)].some(
          (line) => 'request_id' in line,
        ),
      ).toBe(false);
      expect(captured.join('')).not.toContain(inner);
    });

    it('never logs a uuid delivered as bytes, an array or a number', async () => {
      const inner = randomUUID();
      const ids = [Buffer.from(inner), [inner], 42].map((header, index) =>
        publish('order.paid', orderPaid(eventId, [index + 1]), {
          'x-request-id': header,
        }),
      );

      for (const id of ids) {
        await awaitLogged(id, 'applied');
      }

      expect(await redis.scard(`sold:${eventId}`)).toBe(3);
      expect(
        ids
          .flatMap((id) => linesMentioning(id))
          .some((line) => 'request_id' in line),
      ).toBe(false);
    });

    it('logs a duplicate delivery as skipped under its own request id', async () => {
      const envelope = orderPaid(eventId, [1]);
      const firstId = randomUUID();
      const secondId = randomUUID();
      const id = publish('order.paid', envelope, { 'x-request-id': firstId });

      await awaitLogged(id, 'applied');

      publish('order.paid', envelope, { 'x-request-id': secondId });

      await awaitLogged(id, 'skipped duplicate');

      const skipped = linesMentioning(`skipped duplicate order.paid ${id}`);

      expect(skipped).toEqual([
        expect.objectContaining({ request_id: secondId }),
      ]);
    });

    it('carries the id on every retry and on the dead-letter line', async () => {
      failingEventId = eventId;

      const requestId = randomUUID();
      const id = publish('order.paid', orderPaid(eventId, [1]), {
        'x-request-id': requestId,
      });

      await waitFor(
        'the poison message to reach the dead-letter queue',
        () => depthOf(topology.deadLetterQueue),
        (value) => value === 1,
      );
      await channel.get(topology.deadLetterQueue, { noAck: true });

      const lines = linesMentioning(id);
      const levels = lines.map((line) => line.level);

      expect(levels.filter((level) => level === 40)).toHaveLength(2);
      expect(levels.filter((level) => level === 50)).toHaveLength(1);
      expect(levels.filter((level) => level === 30)).toHaveLength(3);
      expect(lines.every((line) => line.request_id === requestId)).toBe(true);
    });

    it('reaches the lines ConsumerService logs itself', async () => {
      const requestId = randomUUID();
      const envelope = paymentFailed(eventId, [1], randomUUID());
      const orderId = (envelope.payload as { order_id: string }).order_id;
      const id = publish('order.payment_failed', envelope, {
        'x-request-id': requestId,
      });

      await awaitConsumed(id);

      const line = await waitFor(
        'the ConsumerService payment_failed line',
        () =>
          Promise.resolve(
            logLines().find(
              (entry) =>
                entry.context === 'ConsumerService' &&
                entry.msg.includes(orderId),
            ),
          ),
        (value) => value !== undefined,
      );

      expect(line).toEqual(expect.objectContaining({ request_id: requestId }));
    });
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

      await redis.set(
        `hold:${eventId}:1`,
        JSON.stringify({ sessionId: later, heldAt: new Date().toISOString() }),
        'EX',
        600,
      );

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

    it('stores the published seat list without an expiry next to the warm marker', async () => {
      const id = publish(
        'event.published',
        eventPublished(eventId, [10, 11, 12]),
      );

      await awaitConsumed(id);

      expect(
        (await redis.smembers(`seats:${eventId}`))
          .map(Number)
          .sort((a, b) => a - b),
      ).toEqual([10, 11, 12]);
      expect(await redis.ttl(`seats:${eventId}`)).toBe(-1);
      expect(await redis.exists(`sold-warm:${eventId}`)).toBe(1);
    });

    it('writes nothing when the same envelope is delivered again', async () => {
      const envelope = eventPublished(eventId, [10, 11, 12]);
      const id = publish('event.published', envelope);

      await awaitConsumed(id);
      await redis.del(`seats:${eventId}`, `sold-warm:${eventId}`);

      publish('event.published', envelope);

      await waitFor(
        'the redelivery to be skipped as a duplicate',
        () =>
          Promise.resolve(
            linesMentioning(`skipped duplicate event.published ${id}`).length,
          ),
        (value) => value === 1,
      );

      expect(await redis.exists(`seats:${eventId}`)).toBe(0);
      expect(await redis.exists(`sold-warm:${eventId}`)).toBe(0);
      expect(await depthOf(topology.deadLetterQueue)).toBe(0);
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
