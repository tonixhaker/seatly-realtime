import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { createServer, Server, Socket } from 'node:net';
import { SoldCacheService } from './sold-cache.service';
import {
  SOLD_WARM_TTL_SECONDS,
  seatsKey,
  soldKey,
  soldWarmKey,
} from '../redis/keys';

const EVENT = 4242;
const OTHER_EVENT = 4243;
const CORE = 'http://127.0.0.1:8000';

const SEATS = [
  {
    id: 1,
    section: 'A',
    row: 1,
    number: 1,
    x: 40,
    y: 45,
    price_cents: 8500,
    currency: 'EUR',
    status: 'free',
  },
  {
    id: 2,
    section: 'A',
    row: 1,
    number: 2,
    x: 80,
    y: 45,
    price_cents: 8500,
    currency: 'EUR',
    status: 'sold',
  },
  {
    id: 3,
    section: 'A',
    row: 1,
    number: 3,
    x: 120,
    y: 45,
    price_cents: 8500,
    currency: 'EUR',
    status: 'free',
  },
  {
    id: 4,
    section: 'A',
    row: 1,
    number: 4,
    x: 160,
    y: 45,
    price_cents: 8500,
    currency: 'EUR',
    status: 'sold',
  },
];

const OTHER_SEATS = [
  {
    id: 7,
    section: 'B',
    row: 2,
    number: 1,
    x: 40,
    y: 90,
    price_cents: 9900,
    currency: 'EUR',
    status: 'sold',
  },
];

const THREE_SEATS = [
  { id: 1, status: 'free' },
  { id: 2, status: 'sold' },
  { id: 3, status: 'free' },
];

const members = async (redis: Redis, key: string): Promise<number[]> =>
  (await redis.smembers(key)).map(Number).sort((a, b) => a - b);

const urlOf = (input: string | URL | Request): string => {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
};

const seatsFor = (url: string): unknown[] =>
  url.includes(`/events/${String(OTHER_EVENT)}/`) ? OTHER_SEATS : SEATS;

const answers = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('SoldCacheService', () => {
  let redis: Redis;
  let cache: SoldCacheService;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  const config = {
    get: () => CORE,
  } as unknown as ConfigService<{ CORE_API_URL: string }, true>;

  beforeEach(async () => {
    redis = new RedisMock();
    await redis.flushall();
    cache = new SoldCacheService(redis, config);
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    redis.disconnect();
  });

  it('serves a warm cache without calling core', async () => {
    await redis.sadd(soldKey(EVENT), 2, 4);
    await redis.set(soldWarmKey(EVENT), '', 'EX', 60);
    fetchSpy.mockResolvedValue(answers(SEATS));

    expect(await cache.soldSeats(EVENT)).toEqual([2, 4]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not call core when the marker is present and the set is absent', async () => {
    await redis.set(soldWarmKey(EVENT), '', 'EX', 60);
    fetchSpy.mockResolvedValue(answers(SEATS));

    expect(await cache.soldSeats(EVENT)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await redis.exists(soldKey(EVENT))).toBe(0);
  });

  it('warms from core on a miss, storing only the sold seats and a marker with a ttl', async () => {
    fetchSpy.mockResolvedValue(answers(SEATS));

    expect(await cache.soldSeats(EVENT)).toEqual([2, 4]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      `${CORE}/api/v1/events/${String(EVENT)}/seats`,
    );
    expect((await redis.smembers(soldKey(EVENT))).map(Number).sort()).toEqual([
      2, 4,
    ]);

    const ttl = await redis.ttl(soldWarmKey(EVENT));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('does not call core a second time once warmed', async () => {
    fetchSpy.mockResolvedValue(answers(SEATS));

    await cache.soldSeats(EVENT);
    expect(await cache.soldSeats(EVENT)).toEqual([2, 4]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('treats a core 404 as an event with nothing sold and marks it warm', async () => {
    fetchSpy.mockResolvedValue(answers({ error: { code: 'NOT_FOUND' } }, 404));

    expect(await cache.soldSeats(EVENT)).toEqual([]);
    expect(await redis.exists(soldWarmKey(EVENT))).toBe(1);
    expect(await cache.soldSeats(EVENT)).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('never marks warm on a core 500, so the next request retries', async () => {
    fetchSpy.mockResolvedValue(answers({ error: {} }, 500));

    await expect(cache.soldSeats(EVENT)).rejects.toThrow();
    expect(await redis.exists(soldWarmKey(EVENT))).toBe(0);

    await expect(cache.soldSeats(EVENT)).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('never marks warm on a body that does not match the seat contract', async () => {
    fetchSpy.mockResolvedValue(answers({ data: 'not an array' }));

    await expect(cache.soldSeats(EVENT)).rejects.toThrow();
    expect(await redis.exists(soldWarmKey(EVENT))).toBe(0);
  });

  it('collapses ten concurrent misses into exactly one call to core', async () => {
    fetchSpy.mockImplementation(
      () =>
        new Promise((resolve) => setTimeout(() => resolve(answers(SEATS)), 20)),
    );

    const results = await Promise.all(
      Array.from({ length: 10 }, () => cache.soldSeats(EVENT)),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    results.forEach((result) => expect(result).toEqual([2, 4]));
  });

  it('warms again once the marker expires, which is what repairs a dropped message', async () => {
    fetchSpy.mockResolvedValue(answers(SEATS));

    await cache.soldSeats(EVENT);
    await redis.pexpire(soldWarmKey(EVENT), 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await cache.soldSeats(EVENT);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('unions a re-warm into the set rather than replacing it', async () => {
    await redis.sadd(soldKey(EVENT), 99);
    fetchSpy.mockResolvedValue(answers(SEATS));

    expect(await cache.soldSeats(EVENT)).toEqual([2, 4, 99]);
  });

  it('serves the stale set when core is unreachable and we have positive knowledge', async () => {
    await redis.sadd(soldKey(EVENT), 2, 4);
    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));

    expect(await cache.soldSeats(EVENT)).toEqual([2, 4]);
    expect(await redis.exists(soldWarmKey(EVENT))).toBe(0);
  });

  it('refuses to guess when core is unreachable and the cache is genuinely cold', async () => {
    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(cache.soldSeats(EVENT)).rejects.toMatchObject({
      response: { code: 'SOLD_STATE_UNAVAILABLE' },
    });
  });

  it('sorts the sold seats as numbers, so seat 9 comes before seat 10', async () => {
    fetchSpy.mockResolvedValue(
      answers([
        { id: 100, status: 'sold' },
        { id: 9, status: 'sold' },
        { id: 10, status: 'sold' },
        { id: 2, status: 'free' },
      ]),
    );

    expect(await cache.soldSeats(EVENT)).toEqual([9, 10, 100]);
  });

  it('counts only what core calls sold, not merely what it does not call free', async () => {
    fetchSpy.mockResolvedValue(
      answers([
        { id: 1, status: 'reserved' },
        { id: 2, status: 'sold' },
        { id: 3, status: 'free' },
      ]),
    );

    expect(await cache.soldSeats(EVENT)).toEqual([2]);
  });

  it('marks the event warm for a full minute rather than for a moment', async () => {
    fetchSpy.mockResolvedValue(answers(SEATS));

    await cache.soldSeats(EVENT);

    expect(SOLD_WARM_TTL_SECONDS).toBe(60);
    expect(await redis.ttl(soldWarmKey(EVENT))).toBe(SOLD_WARM_TTL_SECONDS);
  });

  it('leaves the sold set itself without an expiry, so it outlives the marker', async () => {
    fetchSpy.mockResolvedValue(answers(SEATS));

    await cache.soldSeats(EVENT);

    expect(await redis.ttl(soldKey(EVENT))).toBe(-1);
  });

  it('never answers one event out of another event cache', async () => {
    fetchSpy.mockImplementation((input) =>
      Promise.resolve(answers(seatsFor(urlOf(input)))),
    );

    expect(await cache.soldSeats(EVENT)).toEqual([2, 4]);
    expect(await cache.soldSeats(OTHER_EVENT)).toEqual([7]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    expect(await cache.soldSeats(EVENT)).toEqual([2, 4]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps concurrent misses for two events apart rather than sharing one answer', async () => {
    fetchSpy.mockImplementation(
      (input) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(answers(seatsFor(urlOf(input)))), 20),
        ),
    );

    expect(
      await Promise.all([cache.soldSeats(EVENT), cache.soldSeats(OTHER_EVENT)]),
    ).toEqual([[2, 4], [7]]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  describe('the seat list', () => {
    it('stores every seat core returns without an expiry, and only the sold ones as sold', async () => {
      fetchSpy.mockResolvedValue(answers(THREE_SEATS));

      expect(await cache.soldSeats(EVENT)).toEqual([2]);
      expect(await members(redis, seatsKey(EVENT))).toEqual([1, 2, 3]);
      expect(await redis.ttl(seatsKey(EVENT))).toBe(-1);
      expect(await members(redis, soldKey(EVENT))).toEqual([2]);
    });

    it('writes no seat list for an event core does not know', async () => {
      fetchSpy.mockResolvedValue(
        answers({ error: { code: 'NOT_FOUND' } }, 404),
      );

      expect(await cache.soldSeats(EVENT)).toEqual([]);
      expect(await redis.exists(seatsKey(EVENT))).toBe(0);
    });

    it('answers nothing sold rather than failing when core is unreachable and the seat list is known', async () => {
      await redis.sadd(seatsKey(EVENT), 1, 2, 3);
      fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));

      expect(await cache.soldSeats(EVENT)).toEqual([]);
      expect(await redis.exists(soldWarmKey(EVENT))).toBe(0);
    });

    it('answers nothing sold rather than failing when core errors and the seat list is known', async () => {
      await redis.sadd(seatsKey(EVENT), 1, 2, 3);
      fetchSpy.mockResolvedValue(answers({ error: {} }, 500));

      expect(await cache.soldSeats(EVENT)).toEqual([]);
    });

    it('still refuses with SOLD_STATE_UNAVAILABLE when neither the seat list nor a sold set is known', async () => {
      fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));

      await expect(cache.soldSeats(EVENT)).rejects.toMatchObject({
        response: { code: 'SOLD_STATE_UNAVAILABLE' },
      });
      expect(await redis.exists(seatsKey(EVENT))).toBe(0);
    });
  });

  describe('markSold and markPublished', () => {
    it('unions the paid seats into a set that already exists', async () => {
      await redis.sadd(soldKey(EVENT), 99);

      await cache.markSold(EVENT, [2, 4]);

      expect(
        (await redis.smembers(soldKey(EVENT)))
          .map(Number)
          .sort((a, b) => a - b),
      ).toEqual([2, 4, 99]);
      expect(await redis.ttl(soldKey(EVENT))).toBe(-1);
    });

    it('does not mark the event warm, so a cold cache still asks core', async () => {
      await cache.markSold(EVENT, [2]);

      expect(await redis.exists(soldWarmKey(EVENT))).toBe(0);
    });

    it('writes nothing at all when the order paid for no seats', async () => {
      const sadd = jest.spyOn(redis, 'sadd');

      await cache.markSold(EVENT, []);

      expect(sadd).toHaveBeenCalledTimes(0);
      expect(await redis.keys('*')).toEqual([]);
    });

    it('marks an event warm for a minute without creating a sold set', async () => {
      await cache.markPublished(EVENT, []);

      expect(await redis.ttl(soldWarmKey(EVENT))).toBe(60);
      expect(await redis.exists(soldKey(EVENT))).toBe(0);
    });

    it('stores the published seat list without an expiry next to a one-minute marker', async () => {
      await cache.markPublished(EVENT, [10, 11, 12]);

      expect(await members(redis, seatsKey(EVENT))).toEqual([10, 11, 12]);
      expect(await redis.ttl(seatsKey(EVENT))).toBe(-1);
      expect(await redis.ttl(soldWarmKey(EVENT))).toBe(60);
      expect(await redis.exists(soldKey(EVENT))).toBe(0);
    });

    it('writes only the marker when the event was published with no seats', async () => {
      await cache.markPublished(EVENT, []);

      expect(await redis.keys('*')).toEqual([soldWarmKey(EVENT)]);
    });
  });

  describe('against a socket that accepts and never answers', () => {
    let idle: Server;
    let stalled: SoldCacheService;
    let accepted: Socket[];

    beforeEach(async () => {
      fetchSpy.mockRestore();
      accepted = [];
      idle = createServer((socket) => accepted.push(socket));
      await new Promise<void>((resolve) =>
        idle.listen(0, '127.0.0.1', resolve),
      );
      const { port } = idle.address() as { port: number };
      stalled = new SoldCacheService(redis, {
        get: () => `http://127.0.0.1:${String(port)}`,
      } as unknown as ConfigService<{ CORE_API_URL: string }, true>);
    });

    afterEach(async () => {
      accepted.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => idle.close(() => resolve()));
    });

    it('gives up at the core timeout rather than minutes later', async () => {
      const started = Date.now();

      await expect(stalled.soldSeats(EVENT)).rejects.toThrow();

      expect(Date.now() - started).toBeLessThan(4000);
    }, 8000);

    it('gives up instead of hanging, so live-seats cannot be held open by core', async () => {
      await expect(stalled.soldSeats(EVENT)).rejects.toMatchObject({
        response: { code: 'SOLD_STATE_UNAVAILABLE' },
      });
    }, 8000);
  });
});
