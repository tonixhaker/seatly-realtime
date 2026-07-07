import type Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { HoldPayload, HoldStoreService } from './hold-store.service';

const EVENT = 42;
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('HoldStoreService', () => {
  let redis: Redis;
  let store: HoldStoreService;

  beforeEach(async () => {
    redis = new RedisMock();
    await redis.flushall();
    store = new HoldStoreService(redis);
  });

  afterEach(() => {
    redis.disconnect();
  });

  const keyCount = async (): Promise<number> => (await redis.keys('*')).length;

  it('takes four free seats and records them in the session set', async () => {
    const outcome = await store.acquire({
      eventId: EVENT,
      seatIds: [1, 2, 3, 4],
      sessionId: SESSION,
    });

    expect(outcome).toEqual({ ok: true, acquired: [1, 2, 3, 4], retained: [] });
    expect((await redis.keys(`hold:${EVENT}:*`)).length).toBe(4);
    expect(await redis.exists(`session:${SESSION}`)).toBe(1);
    expect(
      (await redis.smembers(`session:${SESSION}`)).map(String).sort(),
    ).toEqual(['1', '2', '3', '4']);
  });

  it('writes sessionId first and omits userId when absent', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [3], sessionId: SESSION });

    const raw = await redis.get(`hold:${EVENT}:3`);
    expect(raw).toMatch(/^\{"sessionId":/);

    const payload = JSON.parse(raw as string) as HoldPayload;
    expect(Object.keys(payload)).toEqual(['sessionId', 'heldAt']);
    expect(payload.sessionId).toBe(SESSION);
  });

  it('carries userId into the payload when supplied', async () => {
    await store.acquire({
      eventId: EVENT,
      seatIds: [3],
      sessionId: SESSION,
      userId: 7,
    });

    const payload = JSON.parse(
      (await redis.get(`hold:${EVENT}:3`)) as string,
    ) as { userId?: number };
    expect(payload.userId).toBe(7);

    const again = await store.acquire({
      eventId: EVENT,
      seatIds: [3],
      sessionId: SESSION,
      userId: 7,
    });
    expect(again).toEqual({ ok: true, acquired: [], retained: [3] });
  });

  it('leaves zero new keys behind when one seat belongs to another session', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [3], sessionId: OTHER });
    const before = await keyCount();

    const outcome = await store.acquire({
      eventId: EVENT,
      seatIds: [3, 9, 10],
      sessionId: SESSION,
    });

    expect(outcome).toEqual({ ok: false, conflicts: [3] });
    expect(await keyCount()).toBe(before);
    expect(await redis.exists(`session:${SESSION}`)).toBe(0);
  });

  it('reports every conflicting seat in request order', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [7, 3], sessionId: OTHER });

    const outcome = await store.acquire({
      eventId: EVENT,
      seatIds: [7, 3, 9],
      sessionId: SESSION,
    });

    expect(outcome).toEqual({ ok: false, conflicts: [7, 3] });
  });

  it('does not rewrite a seat the same session already holds', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [1], sessionId: SESSION });
    const first = await redis.get(`hold:${EVENT}:1`);

    const outcome = await store.acquire({
      eventId: EVENT,
      seatIds: [1, 2],
      sessionId: SESSION,
    });

    expect(outcome).toEqual({ ok: true, acquired: [2], retained: [1] });
    expect(await redis.get(`hold:${EVENT}:1`)).toBe(first);
  });

  it('keeps seats the caller already held when the attempt conflicts', async () => {
    await store.acquire({
      eventId: EVENT,
      seatIds: [1, 2],
      sessionId: SESSION,
    });
    const held = await redis.mget(`hold:${EVENT}:1`, `hold:${EVENT}:2`);
    await store.acquire({ eventId: EVENT, seatIds: [5], sessionId: OTHER });

    const outcome = await store.acquire({
      eventId: EVENT,
      seatIds: [1, 2, 5],
      sessionId: SESSION,
    });

    expect(outcome).toEqual({ ok: false, conflicts: [5] });
    expect(await redis.mget(`hold:${EVENT}:1`, `hold:${EVENT}:2`)).toEqual(
      held,
    );
    expect(
      (await redis.smembers(`session:${SESSION}`)).map(String).sort(),
    ).toEqual(['1', '2']);
  });

  it('releases its own seats and drops them from the session set', async () => {
    await store.acquire({
      eventId: EVENT,
      seatIds: [1, 2, 3],
      sessionId: SESSION,
    });

    expect(
      await store.release({
        eventId: EVENT,
        seatIds: [1, 2],
        sessionId: SESSION,
      }),
    ).toEqual([1, 2]);
    expect(await redis.exists(`hold:${EVENT}:1`)).toBe(0);
    expect((await redis.smembers(`session:${SESSION}`)).map(String)).toEqual([
      '3',
    ]);
  });

  it('changes nothing when releasing seats held by another session', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [1], sessionId: OTHER });
    const payload = await redis.get(`hold:${EVENT}:1`);

    expect(
      await store.release({ eventId: EVENT, seatIds: [1], sessionId: SESSION }),
    ).toEqual([]);
    expect(await redis.get(`hold:${EVENT}:1`)).toBe(payload);
    expect((await redis.smembers(`session:${OTHER}`)).map(String)).toEqual([
      '1',
    ]);
  });

  it('releases only the subset it owns', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [1], sessionId: SESSION });
    await store.acquire({ eventId: EVENT, seatIds: [2], sessionId: OTHER });

    expect(
      await store.release({
        eventId: EVENT,
        seatIds: [1, 2],
        sessionId: SESSION,
      }),
    ).toEqual([1]);
    expect(await redis.exists(`hold:${EVENT}:2`)).toBe(1);
  });

  it('ignores seats with no hold key and releases the same seats twice without error', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [1], sessionId: SESSION });

    expect(
      await store.release({
        eventId: EVENT,
        seatIds: [1, 2],
        sessionId: SESSION,
      }),
    ).toEqual([1]);
    expect(
      await store.release({
        eventId: EVENT,
        seatIds: [1, 2],
        sessionId: SESSION,
      }),
    ).toEqual([]);
    expect(await keyCount()).toBe(0);
  });

  it('reports nothing missing when the session holds every requested seat', async () => {
    await store.acquire({
      eventId: EVENT,
      seatIds: [1, 2],
      sessionId: SESSION,
    });

    expect(
      await store.missing({
        eventId: EVENT,
        seatIds: [1, 2],
        sessionId: SESSION,
      }),
    ).toEqual([]);
  });

  it('reports a seat held by another session as missing', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [1, 2], sessionId: OTHER });

    expect(
      await store.missing({
        eventId: EVENT,
        seatIds: [1, 2],
        sessionId: SESSION,
      }),
    ).toEqual([1, 2]);
  });

  it('reports a seat with no hold key as missing', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [1], sessionId: SESSION });

    expect(
      await store.missing({
        eventId: EVENT,
        seatIds: [1, 9],
        sessionId: SESSION,
      }),
    ).toEqual([9]);
  });

  it('does not carry a hold at one event over to another event', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [1], sessionId: SESSION });

    expect(
      await store.missing({
        eventId: EVENT + 1,
        seatIds: [1],
        sessionId: SESSION,
      }),
    ).toEqual([1]);
  });

  it('reports a seat whose hold key has expired as missing', async () => {
    await store.acquire({
      eventId: EVENT,
      seatIds: [1, 2],
      sessionId: SESSION,
    });
    await redis.del(`hold:${EVENT}:1`);

    expect(
      await store.missing({
        eventId: EVENT,
        seatIds: [1, 2],
        sessionId: SESSION,
      }),
    ).toEqual([1]);
  });

  it('reports missing seats in request order rather than sorted', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [2], sessionId: SESSION });

    expect(
      await store.missing({
        eventId: EVENT,
        seatIds: [9, 2, 4],
        sessionId: SESSION,
      }),
    ).toEqual([9, 4]);
  });

  it('rejects a script result that does not cover every requested seat', async () => {
    const stub = {
      eval: () => Promise.resolve('TT'),
    } as unknown as Redis;

    await expect(
      new HoldStoreService(stub).acquire({
        eventId: EVENT,
        seatIds: [1, 2, 3],
        sessionId: SESSION,
      }),
    ).rejects.toThrow('unusable result');
  });
});
