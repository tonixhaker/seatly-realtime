import type Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { HoldPayload, HoldStoreService } from './hold-store.service';
import {
  expiryKey,
  holdKey,
  holdPattern,
  parseHoldSeatId,
  sessionKey,
  sessionMember,
} from '../redis/keys';

const EVENT = 42;
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('holdPattern and parseHoldSeatId', () => {
  it('matches the hold keys of one event and no other', () => {
    expect(holdPattern(EVENT)).toBe(`hold:${String(EVENT)}:*`);
  });

  it('reads the seat id out of a hold key of the event asked about', () => {
    expect(parseHoldSeatId(holdKey(EVENT, 7), EVENT)).toBe(7);
  });

  it.each([
    [holdKey(421, 7)],
    [holdKey(4, 7)],
    [`${holdKey(EVENT, 7)}:meta`],
    [expiryKey(SESSION, EVENT, 7)],
    [sessionKey(SESSION)],
    [`hold:${String(EVENT)}:not-a-seat`],
    [''],
  ])('refuses %s as a held seat of event 42', (key) => {
    expect(parseHoldSeatId(key, EVENT)).toBeNull();
  });
});

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
    ).toEqual([1, 2, 3, 4].map((seatId) => sessionMember(EVENT, seatId)));
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
    ).toEqual([1, 2].map((seatId) => sessionMember(EVENT, seatId)));
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
      sessionMember(EVENT, 3),
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
      sessionMember(EVENT, 1),
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

  it('writes one companion key per newly taken seat', async () => {
    await store.acquire({
      eventId: EVENT,
      seatIds: [1, 2],
      sessionId: SESSION,
    });

    expect(await redis.exists(expiryKey(SESSION, EVENT, 1))).toBe(1);
    expect(await redis.exists(expiryKey(SESSION, EVENT, 2))).toBe(1);
    expect(await redis.ttl(expiryKey(SESSION, EVENT, 1))).toBeGreaterThan(0);
  });

  it('does not rewrite the companion of a seat it already held', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [1], sessionId: SESSION });
    await redis.set(expiryKey(SESSION, EVENT, 1), 'sentinel', 'EX', 600);

    const outcome = await store.acquire({
      eventId: EVENT,
      seatIds: [1, 2],
      sessionId: SESSION,
    });

    expect(outcome).toEqual({ ok: true, acquired: [2], retained: [1] });
    expect(await redis.get(expiryKey(SESSION, EVENT, 1))).toBe('sentinel');
  });

  it('leaves no companion key behind when the attempt conflicts', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [3], sessionId: OTHER });

    await store.acquire({
      eventId: EVENT,
      seatIds: [1, 3],
      sessionId: SESSION,
    });

    expect(await redis.exists(expiryKey(SESSION, EVENT, 1))).toBe(0);
  });

  it('deletes the companion key of a seat it releases', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [1], sessionId: SESSION });

    await store.release({ eventId: EVENT, seatIds: [1], sessionId: SESSION });

    expect(await redis.exists(expiryKey(SESSION, EVENT, 1))).toBe(0);
  });

  it('refreshes the session TTL only when a seat is newly taken', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [1], sessionId: SESSION });
    await redis.expire(`session:${SESSION}`, 100);

    await store.acquire({ eventId: EVENT, seatIds: [1], sessionId: SESSION });
    expect(await redis.ttl(`session:${SESSION}`)).toBeLessThanOrEqual(100);

    await store.acquire({ eventId: EVENT, seatIds: [2], sessionId: SESSION });
    expect(await redis.ttl(`session:${SESSION}`)).toBeGreaterThan(100);
  });

  it('removes exactly the expired member from its own session set', async () => {
    await store.acquire({
      eventId: EVENT,
      seatIds: [1, 2],
      sessionId: SESSION,
    });

    expect(
      await store.forgetExpired({
        sessionId: SESSION,
        eventId: EVENT,
        seatId: 1,
      }),
    ).toBe(1);
    expect((await redis.smembers(`session:${SESSION}`)).map(String)).toEqual([
      sessionMember(EVENT, 2),
    ]);
  });

  it('is a no-op when the expired member is not in the session set', async () => {
    await store.acquire({ eventId: EVENT, seatIds: [1], sessionId: SESSION });

    expect(
      await store.forgetExpired({
        sessionId: SESSION,
        eventId: EVENT + 1,
        seatId: 1,
      }),
    ).toBe(0);
    expect((await redis.smembers(`session:${SESSION}`)).map(String)).toEqual([
      sessionMember(EVENT, 1),
    ]);
  });

  describe('forceRelease', () => {
    it('releases a hold owned by a session the caller does not have', async () => {
      await store.acquire({ eventId: EVENT, seatIds: [1], sessionId: OTHER });

      expect(
        await store.forceRelease({ eventId: EVENT, seatIds: [1] }),
      ).toEqual([1]);
      expect(await redis.exists(holdKey(EVENT, 1))).toBe(0);
    });

    it('deletes the owner companion key and drops exactly its session member', async () => {
      await store.acquire({
        eventId: EVENT,
        seatIds: [1, 2],
        sessionId: OTHER,
      });

      await store.forceRelease({ eventId: EVENT, seatIds: [1] });

      expect(await redis.exists(expiryKey(OTHER, EVENT, 1))).toBe(0);
      expect(await redis.exists(expiryKey(OTHER, EVENT, 2))).toBe(1);
      expect((await redis.smembers(sessionKey(OTHER))).map(String)).toEqual([
        sessionMember(EVENT, 2),
      ]);
    });

    it('leaves a hold on a seat it was not asked about untouched', async () => {
      await store.acquire({ eventId: EVENT, seatIds: [1], sessionId: OTHER });
      await store.acquire({ eventId: EVENT, seatIds: [2], sessionId: SESSION });
      const kept = await redis.get(holdKey(EVENT, 2));

      await store.forceRelease({ eventId: EVENT, seatIds: [1] });

      expect(await redis.get(holdKey(EVENT, 2))).toBe(kept);
      expect(await redis.exists(expiryKey(SESSION, EVENT, 2))).toBe(1);
      expect((await redis.smembers(sessionKey(SESSION))).map(String)).toEqual([
        sessionMember(EVENT, 2),
      ]);
    });

    it('returns only the seats it actually deleted, in request order', async () => {
      await store.acquire({
        eventId: EVENT,
        seatIds: [9, 4],
        sessionId: OTHER,
      });

      expect(
        await store.forceRelease({ eventId: EVENT, seatIds: [9, 2, 4] }),
      ).toEqual([9, 4]);
    });

    it('does not run a script at all for an empty seat list', async () => {
      const evaluate = jest.spyOn(redis, 'eval');

      expect(await store.forceRelease({ eventId: EVENT, seatIds: [] })).toEqual(
        [],
      );
      expect(evaluate).toHaveBeenCalledTimes(0);
    });

    it('deletes a hold whose payload names no session', async () => {
      await redis.set(
        holdKey(EVENT, 5),
        JSON.stringify({ heldAt: '2026-10-01T18:42:11Z' }),
      );

      expect(
        await store.forceRelease({ eventId: EVENT, seatIds: [5] }),
      ).toEqual([5]);
      expect(await redis.exists(holdKey(EVENT, 5))).toBe(0);
    });
  });

  describe('heldSeats', () => {
    it('returns the seats held at this event, ascending, and nothing from another event', async () => {
      await store.acquire({
        eventId: EVENT,
        seatIds: [9, 2],
        sessionId: SESSION,
      });
      await store.acquire({
        eventId: EVENT + 1,
        seatIds: [4],
        sessionId: SESSION,
      });

      expect(await store.heldSeats(EVENT)).toEqual([2, 9]);
      expect(await store.heldSeats(EVENT + 1)).toEqual([4]);
    });

    it('answers an event with no holds with an empty array', async () => {
      await store.acquire({
        eventId: EVENT + 5,
        seatIds: [1],
        sessionId: SESSION,
      });

      expect(await store.heldSeats(EVENT)).toEqual([]);
    });

    it('never reports the expiry companion or the session key as a held seat', async () => {
      await store.acquire({ eventId: EVENT, seatIds: [1], sessionId: SESSION });

      expect(await redis.keys('*')).toEqual(
        expect.arrayContaining([expiryKey(SESSION, EVENT, 1)]),
      );
      expect(await store.heldSeats(EVENT)).toEqual([1]);
    });

    it('follows the cursor past the first page instead of stopping at it', async () => {
      const scan = jest
        .spyOn(redis, 'scan')
        .mockResolvedValueOnce(['17', [`hold:${EVENT}:5`]] as never)
        .mockResolvedValueOnce(['0', [`hold:${EVENT}:6`]] as never);

      expect(await store.heldSeats(EVENT)).toEqual([5, 6]);
      expect(scan).toHaveBeenCalledTimes(2);
    });

    it('ignores a key SCAN hands back that is not a hold of this event', async () => {
      jest
        .spyOn(redis, 'scan')
        .mockResolvedValueOnce([
          '0',
          [`hold:${String(EVENT)}:5`, 'hold:421:6', `session:${SESSION}`],
        ] as never);

      expect(await store.heldSeats(EVENT)).toEqual([5]);
    });

    it('never reports a hold of an event whose id merely starts with this one', async () => {
      await store.acquire({ eventId: EVENT, seatIds: [7], sessionId: SESSION });
      await store.acquire({ eventId: 421, seatIds: [8], sessionId: SESSION });
      await store.acquire({ eventId: 4, seatIds: [9], sessionId: SESSION });

      expect(await store.heldSeats(EVENT)).toEqual([7]);
      expect(await store.heldSeats(4)).toEqual([9]);
      expect(await store.heldSeats(421)).toEqual([8]);
    });

    it('counts a seat once when SCAN returns its key on two pages', async () => {
      jest
        .spyOn(redis, 'scan')
        .mockResolvedValueOnce(['17', [`hold:${EVENT}:5`]] as never)
        .mockResolvedValueOnce([
          '0',
          [`hold:${EVENT}:5`, `hold:${EVENT}:6`],
        ] as never);

      expect(await store.heldSeats(EVENT)).toEqual([5, 6]);
    });
  });
});
