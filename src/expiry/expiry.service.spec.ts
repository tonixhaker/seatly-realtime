import type Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import {
  SeatEventsService,
  SeatsReleased,
} from '../events/seat-events.service';
import { ExpiryService } from './expiry.service';
import { HoldStoreService } from '../holds/hold-store.service';
import { expiryKey, parseExpiryKey, sessionMember } from '../redis/keys';

const EVENT = 42;
const OTHER_EVENT = 43;
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('parseExpiryKey', () => {
  it('recovers the session, event and seat from a companion key', () => {
    expect(parseExpiryKey(expiryKey(SESSION, 700001, 12))).toEqual({
      sessionId: SESSION,
      eventId: 700001,
      seatId: 12,
    });
  });

  it.each([
    ['hold:700001:12'],
    ['session:aaaa'],
    ['barrier:run:1'],
    ['expiry:'],
    ['expiry:only-two:12'],
    ['expiry:sess:12:not-a-seat'],
    [''],
  ])('returns null for %s', (key) => {
    expect(parseExpiryKey(key)).toBeNull();
  });
});

describe('ExpiryService', () => {
  let redis: Redis;
  let store: HoldStoreService;
  let service: ExpiryService;
  let seatEvents: SeatEventsService;
  let released: SeatsReleased[];

  beforeEach(async () => {
    redis = new RedisMock();
    await redis.flushall();
    store = new HoldStoreService(redis);
    seatEvents = new SeatEventsService();
    released = [];
    seatEvents.onReleased((event) => released.push(event));
    service = new ExpiryService(redis, store, seatEvents);
  });

  afterEach(() => {
    service.onModuleDestroy();
    redis.disconnect();
  });

  it('removes the expired seat and leaves the session its other seats', async () => {
    await store.acquire({
      eventId: EVENT,
      seatIds: [1, 2, 3],
      sessionId: SESSION,
    });

    await service.handle(expiryKey(SESSION, EVENT, 2));

    expect(
      (await redis.smembers(`session:${SESSION}`)).map(String).sort(),
    ).toEqual([1, 3].map((seatId) => sessionMember(EVENT, seatId)));
  });

  it('removes the seat at the event that expired, not the same seat elsewhere', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [1], sessionId: SESSION });
    await store.acquire({
      eventId: OTHER_EVENT,
      seatIds: [1],
      sessionId: SESSION,
    });

    await service.handle(expiryKey(SESSION, EVENT, 1));

    expect((await redis.smembers(`session:${SESSION}`)).map(String)).toEqual([
      sessionMember(OTHER_EVENT, 1),
    ]);
  });

  it('never touches a different session set', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [1], sessionId: SESSION });
    await store.acquire({ eventId: EVENT, seatIds: [2], sessionId: OTHER });

    await service.handle(expiryKey(OTHER, EVENT, 2));

    expect((await redis.smembers(`session:${SESSION}`)).map(String)).toEqual([
      sessionMember(EVENT, 1),
    ]);
    expect(await redis.smembers(`session:${OTHER}`)).toEqual([]);
  });

  it('ignores a key that is not a companion key', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [1], sessionId: SESSION });

    await service.handle(`hold:${EVENT}:1`);
    await service.handle(`session:${SESSION}`);

    expect((await redis.smembers(`session:${SESSION}`)).map(String)).toEqual([
      sessionMember(EVENT, 1),
    ]);
  });

  it('broadcasts the one expired seat of the event it expired at', async () => {
    await service.handle(expiryKey(SESSION, EVENT, 7));

    expect(released).toEqual([{ eventId: EVENT, seatIds: [7] }]);
  });

  it.each([
    [`hold:${String(EVENT)}:7`],
    [`session:${SESSION}`],
    [`sold-warm:${String(EVENT)}`],
    ['consumed:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
  ])('broadcasts nothing for %s', async (key) => {
    await service.handle(key);

    expect(released).toEqual([]);
  });

  it('still broadcasts when the session cleanup fails, because the seat is free', async () => {
    jest
      .spyOn(store, 'forgetExpired')
      .mockRejectedValue(new Error('redis is briefly unavailable'));

    await service.handle(expiryKey(SESSION, EVENT, 9));

    expect(released).toEqual([{ eventId: EVENT, seatIds: [9] }]);
  });
});
