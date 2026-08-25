import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { HoldStoreService } from '../src/holds/hold-store.service';
import { seatsKey, sessionMember, soldWarmKey } from '../src/redis/keys';
import { knownSeats } from './support/known-seats';

const BASE_EVENT_ID = 900000 + Math.floor(Math.random() * 90000);

describe('hold store against a real Redis', () => {
  let redis: Redis;
  let store: HoldStoreService;
  let eventId: number;
  let mine: string;
  let theirs: string;
  let nextEventId = BASE_EVENT_ID;

  beforeAll(() => {
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
    });
    store = new HoldStoreService(redis);
  });

  beforeEach(async () => {
    eventId = ++nextEventId;
    mine = randomUUID();
    theirs = randomUUID();
    await knownSeats(redis, eventId);
  });

  afterEach(async () => {
    const keys = [
      ...(await redis.keys(`hold:${eventId}:*`)),
      ...(await redis.keys(`expiry:*:${eventId}:*`)),
    ];
    await redis.del(
      ...keys,
      `session:${mine}`,
      `session:${theirs}`,
      seatsKey(eventId),
      soldWarmKey(eventId),
    );
  });

  afterAll(async () => {
    await redis.quit();
  });

  const snapshot = async (): Promise<string[]> =>
    [
      ...(await redis.keys(`hold:${eventId}:*`)),
      ...(await redis.keys(`expiry:*:${eventId}:*`)),
      ...(await redis.keys(`session:${mine}`)),
      ...(await redis.keys(`session:${theirs}`)),
    ].sort();

  it('creates exactly four hold keys and one session entry for four free seats', async () => {
    const outcome = await store.acquire({
      eventId,
      seatIds: [1, 2, 3, 4],
      sessionId: mine,
    });

    expect(outcome).toEqual({ ok: true, acquired: [1, 2, 3, 4], retained: [] });
    expect(await redis.keys(`hold:${eventId}:*`)).toHaveLength(4);
    expect(await redis.exists(`session:${mine}`)).toBe(1);
    expect((await redis.smembers(`session:${mine}`)).sort()).toEqual(
      [1, 2, 3, 4].map((seatId) => sessionMember(eventId, seatId)),
    );
  });

  it('leaves zero new keys behind when one seat is held by another session', async () => {
    await store.acquire({ eventId, seatIds: [3], sessionId: theirs });
    const before = await snapshot();

    const outcome = await store.acquire({
      eventId,
      seatIds: [3, 9, 10],
      sessionId: mine,
    });

    expect(outcome).toEqual({ ok: false, conflicts: [3] });
    expect(await snapshot()).toEqual(before);
  });

  it('gives a new hold key a TTL within a second of 600', async () => {
    await store.acquire({ eventId, seatIds: [1, 2], sessionId: mine });

    expect(await redis.ttl(`hold:${eventId}:1`)).toBeGreaterThanOrEqual(599);
    expect(await redis.ttl(`hold:${eventId}:1`)).toBeLessThanOrEqual(600);
    expect(await redis.ttl(`session:${mine}`)).toBeGreaterThanOrEqual(599);
    expect(await redis.ttl(`session:${mine}`)).toBeLessThanOrEqual(600);
  });

  it('does not reset the clock when the same session acquires a seat twice', async () => {
    await store.acquire({ eventId, seatIds: [1], sessionId: mine });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const outcome = await store.acquire({
      eventId,
      seatIds: [1, 2],
      sessionId: mine,
    });

    expect(outcome).toEqual({ ok: true, acquired: [2], retained: [1] });
    expect(await redis.ttl(`hold:${eventId}:1`)).toBeLessThan(600);
    expect(await redis.ttl(`hold:${eventId}:2`)).toBeGreaterThanOrEqual(599);
  });

  it('keeps the seats the caller already held when the attempt conflicts', async () => {
    await store.acquire({ eventId, seatIds: [1, 2], sessionId: mine });
    const held = await redis.mget(`hold:${eventId}:1`, `hold:${eventId}:2`);
    await store.acquire({ eventId, seatIds: [5], sessionId: theirs });

    const outcome = await store.acquire({
      eventId,
      seatIds: [1, 2, 5],
      sessionId: mine,
    });

    expect(outcome).toEqual({ ok: false, conflicts: [5] });
    expect(await redis.mget(`hold:${eventId}:1`, `hold:${eventId}:2`)).toEqual(
      held,
    );
    expect((await redis.smembers(`session:${mine}`)).sort()).toEqual(
      [1, 2].map((seatId) => sessionMember(eventId, seatId)),
    );
  });

  it('changes nothing when releasing seats held by a different session', async () => {
    await store.acquire({ eventId, seatIds: [1, 2], sessionId: theirs });
    const before = await snapshot();
    const payload = await redis.get(`hold:${eventId}:1`);
    const ttl = await redis.ttl(`hold:${eventId}:1`);

    const released = await store.release({
      eventId,
      seatIds: [1, 2],
      sessionId: mine,
    });

    expect(released).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(await redis.get(`hold:${eventId}:1`)).toBe(payload);
    expect(await redis.ttl(`hold:${eventId}:1`)).toBeGreaterThanOrEqual(
      ttl - 1,
    );
    expect((await redis.smembers(`session:${theirs}`)).sort()).toEqual(
      [1, 2].map((seatId) => sessionMember(eventId, seatId)),
    );
  });

  it('drops a session member whose hold key has already expired', async () => {
    await store.acquire({ eventId, seatIds: [1, 2], sessionId: mine });
    await redis.del(`hold:${eventId}:1`);

    expect(
      await store.release({ eventId, seatIds: [1], sessionId: mine }),
    ).toEqual([]);
    expect(await redis.smembers(`session:${mine}`)).toEqual([
      sessionMember(eventId, 2),
    ]);
  });

  it('drops the session entry once its last seat is released', async () => {
    await store.acquire({ eventId, seatIds: [1, 2], sessionId: mine });

    expect(
      await store.release({ eventId, seatIds: [1], sessionId: mine }),
    ).toEqual([1]);
    expect(await redis.smembers(`session:${mine}`)).toEqual([
      sessionMember(eventId, 2),
    ]);

    expect(
      await store.release({ eventId, seatIds: [2], sessionId: mine }),
    ).toEqual([2]);
    expect(await redis.exists(`session:${mine}`)).toBe(0);
    expect(await redis.keys(`hold:${eventId}:*`)).toHaveLength(0);
  });
});
