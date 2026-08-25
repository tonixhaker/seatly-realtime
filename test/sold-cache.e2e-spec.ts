import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { ConfigModule } from '@nestjs/config';
import { HoldsModule } from '../src/holds/holds.module';
import { validateEnv } from '../src/env.schema';
import { HttpExceptionFilter } from '../src/http-exception.filter';
import { seatsKey, soldKey, soldWarmKey } from '../src/redis/keys';
import { CORE_SEATS as SEATS, CoreStub } from './support/core-stub';

const BASE_EVENT_ID = 500000 + Math.floor(Math.random() * 90000);

const buildApp = async (coreUrl: string): Promise<INestApplication<App>> => {
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
      HoldsModule,
    ],
  }).compile();

  const app: INestApplication<App> = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.listen(0);

  return app;
};

const hold = async (
  app: INestApplication<App>,
  eventId: number,
  seatIds: number[],
  sessionId: string,
): Promise<void> => {
  await request(app.getHttpServer())
    .post('/holds')
    .send({ event_id: eventId, seat_ids: seatIds, session_id: sessionId })
    .expect(201);
};

interface LiveSeats {
  held: number[];
  sold: number[];
}

const THREE_SEATS = [
  { id: 1, status: 'free' },
  { id: 2, status: 'sold' },
  { id: 3, status: 'free' },
];

const members = async (redis: Redis, key: string): Promise<number[]> =>
  (await redis.smembers(key)).map(Number).sort((a, b) => a - b);

const liveSeats = async (
  app: INestApplication<App>,
  eventId: number,
): Promise<LiveSeats> => {
  const response = await request(app.getHttpServer())
    .get(`/events/${String(eventId)}/live-seats`)
    .expect(200);

  return response.body as LiveSeats;
};

describe('The sold cache behind GET /events/:id/live-seats (e2e)', () => {
  let app: INestApplication<App>;
  let redis: Redis;
  let core: CoreStub;
  let eventId: number;
  let session: string;
  let coreUrl: string;
  let touched: number[];
  let nextEventId = BASE_EVENT_ID;

  beforeAll(async () => {
    core = new CoreStub();
    coreUrl = await core.start();
    app = await buildApp(coreUrl);
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
    });
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
    await core.stop();
  });

  const useEvent = (): number => {
    const id = ++nextEventId;
    touched.push(id);
    return id;
  };

  beforeEach(() => {
    touched = [];
    eventId = useEvent();
    session = randomUUID();
    core.reset();
    core.serve(SEATS);
  });

  afterEach(async () => {
    const doomed = [`session:${session}`];

    for (const id of touched) {
      doomed.push(
        ...(await redis.keys(`hold:${id}:*`)),
        ...(await redis.keys(`expiry:*:${id}:*`)),
        soldKey(id),
        soldWarmKey(id),
        seatsKey(id),
      );
    }

    await redis.del(...doomed);
  });

  it('reports exactly the seats this session holds', async () => {
    core.answer('empty');
    await hold(app, eventId, [11, 4, 7], session);

    expect((await liveSeats(app, eventId)).held).toEqual([4, 7, 11]);
  });

  it('never reports a hold belonging to another event', async () => {
    core.answer('empty');
    const elsewhere = useEvent();

    await hold(app, eventId, [4], session);
    await hold(app, elsewhere, [9], session);

    expect((await liveSeats(app, eventId)).held).toEqual([4]);
  });

  it('warms from core on a miss and reports the seats core calls sold', async () => {
    expect((await liveSeats(app, eventId)).sold).toEqual([2, 4]);
    expect(core.callCount).toBe(1);
    expect((await redis.smembers(soldKey(eventId))).map(Number).sort()).toEqual(
      [2, 4],
    );
  });

  it('answers a second request from the cache, calling core exactly once in total', async () => {
    const first = await liveSeats(app, eventId);
    const second = await liveSeats(app, eventId);

    expect(second).toEqual(first);
    expect(second.sold).toEqual([2, 4]);
    expect(core.callCount).toBe(1);
  });

  it('never answers one event out of another event cache', async () => {
    await redis.sadd(soldKey(eventId), 99);

    expect((await liveSeats(app, eventId)).sold).toEqual([2, 4, 99]);
    expect(core.callCount).toBe(1);

    const other = useEvent();

    expect((await liveSeats(app, other)).sold).toEqual([2, 4]);
    expect(core.callCount).toBe(2);
  });

  it('does not call core again for an event with nothing sold', async () => {
    core.answer('empty');

    expect((await liveSeats(app, eventId)).sold).toEqual([]);
    expect(core.callCount).toBe(1);
    expect(await redis.exists(soldKey(eventId))).toBe(0);
    expect(await redis.exists(soldWarmKey(eventId))).toBe(1);

    expect((await liveSeats(app, eventId)).sold).toEqual([]);
    expect(core.callCount).toBe(1);
  });

  it('treats an event core does not know as one with nothing sold', async () => {
    core.answer('missing');

    expect(await liveSeats(app, eventId)).toEqual({ held: [], sold: [] });
    expect(core.callCount).toBe(1);

    await liveSeats(app, eventId);
    expect(core.callCount).toBe(1);
  });

  it('retries after a core 500 rather than caching the failure', async () => {
    core.answer('broken');

    await request(app.getHttpServer())
      .get(`/events/${String(eventId)}/live-seats`)
      .expect(503);

    expect(await redis.exists(soldWarmKey(eventId))).toBe(0);

    core.answer('ok');
    expect((await liveSeats(app, eventId)).sold).toEqual([2, 4]);
    expect(core.callCount).toBe(2);
  });

  it('collapses ten concurrent cold requests into exactly one call to core', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app.getHttpServer())
          .get(`/events/${String(eventId)}/live-seats`)
          .expect(200),
      ),
    );

    expect(core.callCount).toBe(1);
    responses.forEach((response) =>
      expect((response.body as LiveSeats).sold).toEqual([2, 4]),
    );
  });

  it('re-warms once the marker expires and unions rather than replacing', async () => {
    await liveSeats(app, eventId);
    await redis.sadd(soldKey(eventId), 99);
    await redis.pexpire(soldWarmKey(eventId), 1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect((await liveSeats(app, eventId)).sold).toEqual([2, 4, 99]);
    expect(core.callCount).toBe(2);
  });

  it('keeps held and sold disjoint, and sold wins', async () => {
    await hold(app, eventId, [4, 7], session);

    const snapshot = await liveSeats(app, eventId);

    expect(snapshot.sold).toContain(4);
    expect(snapshot.held).toEqual([7]);
    expect(snapshot.held).not.toContain(4);
  });

  it('stores every seat core returns without an expiry, and only the sold ones as sold', async () => {
    core.serve(THREE_SEATS);

    expect((await liveSeats(app, eventId)).sold).toEqual([2]);
    expect(await members(redis, seatsKey(eventId))).toEqual([1, 2, 3]);
    expect(await redis.ttl(seatsKey(eventId))).toBe(-1);
    expect(await members(redis, soldKey(eventId))).toEqual([2]);
  });

  it('writes no seat list for an event core does not know', async () => {
    core.answer('missing');

    await liveSeats(app, eventId);

    expect(await redis.exists(seatsKey(eventId))).toBe(0);
  });

  it('answers nothing sold rather than 503 when core errors and the seat list is known', async () => {
    await redis.sadd(seatsKey(eventId), 1, 2, 3);
    core.answer('broken');

    expect((await liveSeats(app, eventId)).sold).toEqual([]);
    expect(core.callCount).toBe(1);
  });

  describe('with core unreachable', () => {
    let closed: INestApplication<App>;
    let deadEventId: number;

    beforeAll(async () => {
      closed = await buildApp('http://127.0.0.1:9');
    });

    afterAll(async () => {
      await closed.close();
    });

    beforeEach(() => {
      deadEventId = useEvent();
    });

    it('refuses to claim nothing is sold when the cache is cold', async () => {
      const response = await request(closed.getHttpServer())
        .get(`/events/${String(deadEventId)}/live-seats`)
        .expect(503);

      expect(response.body).toEqual({
        error: {
          code: 'SOLD_STATE_UNAVAILABLE',
          message: expect.any(String) as string,
        },
      });
    });

    it('keeps the sold set once the marker is gone, which is what it degrades onto', async () => {
      expect((await liveSeats(app, deadEventId)).sold).toEqual([2, 4]);
      expect(await redis.ttl(soldKey(deadEventId))).toBe(-1);

      await redis.del(soldWarmKey(deadEventId));

      const response = await request(closed.getHttpServer())
        .get(`/events/${String(deadEventId)}/live-seats`)
        .expect(200);

      expect((response.body as LiveSeats).sold).toEqual([2, 4]);
    });

    it('answers nothing sold rather than 503 when the seat list is known', async () => {
      await redis.sadd(seatsKey(deadEventId), 1, 2, 3);

      const response = await request(closed.getHttpServer())
        .get(`/events/${String(deadEventId)}/live-seats`)
        .expect(200);

      expect((response.body as LiveSeats).sold).toEqual([]);
    });

    it('serves what it already knows rather than failing', async () => {
      await redis.sadd(soldKey(deadEventId), 4);

      const response = await request(closed.getHttpServer())
        .get(`/events/${String(deadEventId)}/live-seats`)
        .expect(200);

      expect((response.body as LiveSeats).sold).toEqual([4]);
    });
  });
});
