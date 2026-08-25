import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { ConsumerService, HandleOutcome } from './consumer.service';
import { DEFAULT_TOPOLOGY, MAX_ATTEMPTS } from './topology';
import { SeatEventsService, SeatsSold } from '../events/seat-events.service';
import { HoldStoreService } from '../holds/hold-store.service';
import { SoldCacheService } from '../sold/sold-cache.service';
import {
  consumedKey,
  holdKey,
  seatsKey,
  soldKey,
  soldWarmKey,
} from '../redis/keys';

const EVENT = 4242;
const SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORDER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TICKET = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ID_ONE = '11111111-1111-4111-8111-111111111111';
const ID_TWO = '22222222-2222-4222-8222-222222222222';

const envelope = (
  eventType: string,
  payload: unknown,
  eventId: string = ID_ONE,
  occurredAt = '2026-10-01T18:42:11Z',
): Record<string, unknown> => ({
  event_id: eventId,
  event_type: eventType,
  occurred_at: occurredAt,
  version: 1,
  payload,
});

const paid = (seatIds: number[]): Record<string, unknown> => ({
  order_id: ORDER,
  event_id: EVENT,
  seat_ids: seatIds,
  buyer_id: 7,
});

const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

const reasonOf = (outcome: HandleOutcome): string =>
  'reason' in outcome ? outcome.reason : '';

describe('ConsumerService', () => {
  let redis: Redis;
  let sold: SoldCacheService;
  let store: HoldStoreService;
  let seatEvents: SeatEventsService;
  let consumer: ConsumerService;
  let emitted: SeatsSold[];

  beforeEach(async () => {
    jest.clearAllMocks();
    redis = new RedisMock();
    await redis.flushall();
    sold = new SoldCacheService(redis, {
      get: () => 'http://127.0.0.1:8000',
    } as unknown as ConfigService<{ CORE_API_URL: string }, true>);
    store = new HoldStoreService(redis);
    seatEvents = new SeatEventsService();
    emitted = [];
    seatEvents.onSold((sale) => emitted.push(sale));
    consumer = new ConsumerService(redis, sold, store, seatEvents);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    redis.disconnect();
  });

  const keys = async (): Promise<string[]> => (await redis.keys('*')).sort();

  describe('order.paid', () => {
    it('sells exactly the paid seats, releases exactly their holds and emits once', async () => {
      await store.acquire({
        eventId: EVENT,
        seatIds: [1, 2, 3],
        sessionId: SESSION,
      });

      const outcome = await consumer.handle(
        bytes(envelope('order.paid', paid([1, 2]))),
      );

      expect(outcome).toEqual({ status: 'ok', eventId: ID_ONE });
      expect(
        (await redis.smembers(soldKey(EVENT)))
          .map(Number)
          .sort((a, b) => a - b),
      ).toEqual([1, 2]);
      expect(await redis.exists(holdKey(EVENT, 1))).toBe(0);
      expect(await redis.exists(holdKey(EVENT, 2))).toBe(0);
      expect(await redis.exists(holdKey(EVENT, 3))).toBe(1);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toEqual({ eventId: EVENT, seatIds: [1, 2] });
    });

    it('emits once and not twice when the same envelope arrives again', async () => {
      const raw = bytes(envelope('order.paid', paid([1, 2])));

      expect(await consumer.handle(raw)).toEqual({
        status: 'ok',
        eventId: ID_ONE,
      });
      expect(await consumer.handle(raw)).toEqual({
        status: 'duplicate',
        eventId: ID_ONE,
      });
      expect(emitted).toHaveLength(1);
    });

    it('processes two envelopes carrying the same payload under different event ids', async () => {
      const payload = paid([1, 2]);

      expect(
        await consumer.handle(bytes(envelope('order.paid', payload, ID_ONE))),
      ).toEqual({ status: 'ok', eventId: ID_ONE });
      expect(
        await consumer.handle(bytes(envelope('order.paid', payload, ID_TWO))),
      ).toEqual({ status: 'ok', eventId: ID_TWO });
      expect(emitted).toHaveLength(2);
    });

    it('remembers a consumed envelope for a full day', async () => {
      await consumer.handle(bytes(envelope('order.paid', paid([1]))));

      expect(await redis.ttl(consumedKey(ID_ONE))).toBe(86400);
    });

    it('accepts an order that paid for no seats without touching redis or erroring', async () => {
      const outcome = await consumer.handle(
        bytes(envelope('order.paid', paid([]))),
      );

      expect(outcome).toEqual({ status: 'ok', eventId: ID_ONE });
      expect(await redis.exists(soldKey(EVENT))).toBe(0);
      expect(await keys()).toEqual([consumedKey(ID_ONE)]);
    });

    it('reports a failing dependency as failed rather than malformed and forgets the envelope', async () => {
      jest
        .spyOn(sold, 'markSold')
        .mockRejectedValue(new Error('redis is down'));

      const outcome = await consumer.handle(
        bytes(envelope('order.paid', paid([1]))),
      );

      expect(outcome).toEqual({
        status: 'failed',
        eventId: ID_ONE,
        reason: 'redis is down',
      });
      expect(await redis.exists(consumedKey(ID_ONE))).toBe(0);
    });
  });

  describe('order.payment_failed', () => {
    it('leaves every hold alive, writes nothing but the dedup key and emits nothing', async () => {
      await store.acquire({
        eventId: EVENT,
        seatIds: [1, 2],
        sessionId: SESSION,
      });
      const before = await keys();
      const release = jest.spyOn(store, 'forceRelease');

      const outcome = await consumer.handle(
        bytes(
          envelope('order.payment_failed', {
            order_id: ORDER,
            event_id: EVENT,
            seat_ids: [1, 2],
            session_id: SESSION,
          }),
        ),
      );

      expect(outcome).toEqual({ status: 'ok', eventId: ID_ONE });
      expect(release).toHaveBeenCalledTimes(0);
      expect(emitted).toHaveLength(0);
      expect(await keys()).toEqual([...before, consumedKey(ID_ONE)].sort());
    });
  });

  describe('event.published', () => {
    it('marks the event warm with a ttl and creates no sold set', async () => {
      const outcome = await consumer.handle(
        bytes(
          envelope('event.published', { event_id: EVENT, seat_ids: [1, 2, 3] }),
        ),
      );

      expect(outcome).toEqual({ status: 'ok', eventId: ID_ONE });

      const ttl = await redis.ttl(soldWarmKey(EVENT));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
      expect(await redis.exists(soldKey(EVENT))).toBe(0);
      expect(emitted).toHaveLength(0);
    });

    it('stores the published seat list without an expiry', async () => {
      await consumer.handle(
        bytes(
          envelope('event.published', { event_id: EVENT, seat_ids: [1, 2, 3] }),
        ),
      );

      expect(
        (await redis.smembers(seatsKey(EVENT)))
          .map(Number)
          .sort((a, b) => a - b),
      ).toEqual([1, 2, 3]);
      expect(await redis.ttl(seatsKey(EVENT))).toBe(-1);
    });
  });

  describe('tickets.issued', () => {
    it('is accepted and changes nothing', async () => {
      const outcome = await consumer.handle(
        bytes(
          envelope('tickets.issued', {
            order_id: ORDER,
            ticket_ids: [TICKET],
          }),
        ),
      );

      expect(outcome).toEqual({ status: 'ok', eventId: ID_ONE });
      expect(await keys()).toEqual([consumedKey(ID_ONE)]);
      expect(emitted).toHaveLength(0);
    });
  });

  describe('malformed messages', () => {
    it('refuses an event type it has no schema for instead of validating the envelope alone', async () => {
      const outcome = await consumer.handle(
        bytes(envelope('order.refunded', { order_id: ORDER })),
      );

      expect(outcome.status).toBe('malformed');
      expect(reasonOf(outcome)).toContain('no schema for event_type');
      expect(await keys()).toEqual([]);
    });

    it('refuses bytes that are not json', async () => {
      const outcome = await consumer.handle(Buffer.from('not json at all'));

      expect(outcome.status).toBe('malformed');
      expect(await keys()).toEqual([]);
    });

    it('refuses a payload carrying a property the schema does not declare', async () => {
      const outcome = await consumer.handle(
        bytes(
          envelope('order.paid', { ...paid([1, 2]), promo_code: 'SUMMER' }),
        ),
      );

      expect(outcome.status).toBe('malformed');
      expect(await keys()).toEqual([]);
    });

    it('refuses an occurred_at with no utc offset, which the php producer accepts', async () => {
      const outcome = await consumer.handle(
        bytes(envelope('order.paid', paid([1]), ID_ONE, '2026-10-01T18:42:11')),
      );

      expect(outcome.status).toBe('malformed');
      expect(reasonOf(outcome)).toContain('occurred_at');
      expect(await keys()).toEqual([]);
    });

    it.each(['event_id', 'event_type', 'occurred_at', 'version', 'payload'])(
      'refuses an envelope with no %s',
      async (field) => {
        const message = envelope('order.paid', paid([1]));
        delete message[field];

        const outcome = await consumer.handle(bytes(message));

        expect(outcome.status).toBe('malformed');
        expect(await keys()).toEqual([]);
      },
    );
  });

  describe('topology', () => {
    it('names the production exchange, queue and dead letter queue', () => {
      expect(DEFAULT_TOPOLOGY).toEqual({
        exchange: 'seatly.events',
        queue: 'realtime.seatly',
        deadLetterQueue: 'realtime.seatly.dlq',
      });
    });

    it('gives a message three attempts before the dead letter queue', () => {
      expect(MAX_ATTEMPTS).toBe(3);
    });
  });
});
