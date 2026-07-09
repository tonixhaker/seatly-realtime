import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import request from 'supertest';
import { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { HoldsModule } from '../src/holds/holds.module';
import { validateEnv } from '../src/env.schema';
import { HttpExceptionFilter } from '../src/http-exception.filter';
import { holdKey, sessionKey, soldKey, soldWarmKey } from '../src/redis/keys';
import { CoreStub } from './support/core-stub';

const BASE_EVENT_ID = 400000 + Math.floor(Math.random() * 90000);

const MALFORMED_TOKEN = '10|khxAUOcdtRA8JRoovg4t4cds8kEK740Tn0Xw7XWv51d62278';

const issue = (): string => `10|${randomUUID()}`;

const anyString = expect.any(String) as string;

const buildApp = async (coreUrl: string): Promise<INestApplication<App>> => {
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
      HoldsModule,
    ],
  }).compile();

  const app: INestApplication<App> = moduleRef.createNestApplication<App>();
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

interface HoldRecord {
  sessionId: string;
  userId?: number;
  heldAt: string;
}

describe('Token validation through core (e2e)', () => {
  let app: INestApplication<App>;
  let redis: Redis;
  let core: CoreStub;
  let eventId: number;
  let session: string;
  let token: string;
  let otherToken: string;
  let nextEventId = BASE_EVENT_ID;

  const seenBodies: unknown[] = [];
  const logged: string[] = [];

  const http = (): App => app.getHttpServer();

  const post = (seatIds: number[], token?: string) => {
    const pending = request(http())
      .post('/holds')
      .send({ event_id: eventId, seat_ids: seatIds, session_id: session });

    return token === undefined
      ? pending
      : pending.set('Authorization', `Bearer ${token}`);
  };

  const remember = (body: unknown): unknown => {
    seenBodies.push(body);
    return body;
  };

  const record = async (seatId: number): Promise<HoldRecord | null> => {
    const raw = await redis.get(holdKey(eventId, seatId));
    return raw === null ? null : (JSON.parse(raw) as HoldRecord);
  };

  const heldKeys = async (): Promise<string[]> =>
    redis.keys(`hold:${String(eventId)}:*`);

  beforeAll(async () => {
    core = new CoreStub();
    const coreUrl = await core.start();
    app = await buildApp(coreUrl);
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
    });

    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message: unknown, trace?: unknown) => {
        logged.push(`${String(message)} ${String(trace)}`);
      });
  });

  afterEach(async () => {
    const doomed = [
      ...(await redis.keys(`hold:${String(eventId)}:*`)),
      ...(await redis.keys(`expiry:*:${String(eventId)}:*`)),
      sessionKey(session),
      soldKey(eventId),
      soldWarmKey(eventId),
    ];

    await redis.del(...doomed);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
    redis.disconnect();
    await core.stop();
  });

  beforeEach(() => {
    nextEventId += 1;
    eventId = nextEventId;
    session = randomUUID();
    token = issue();
    otherToken = issue();
    core.reset();
  });

  describe('a token core accepts', () => {
    it('authenticates the hold and records the id core returned', async () => {
      const user = core.accept(token, { id: 4 });

      await post([1]).set('Authorization', `Bearer ${token}`).expect(201);

      expect((await record(1))?.userId).toBe(user.id);
      expect(core.meCallCount).toBe(1);
    });

    it('sends the token to core as a verbatim bearer header', async () => {
      core.accept(token);

      await post([1], token).expect(201);

      expect(core.lastAuthorization).toBe(`Bearer ${token}`);
    });

    it('asks core once for the same token used twice inside the window', async () => {
      core.accept(token);

      await post([1], token).expect(201);
      await post([2], token).expect(201);

      expect(core.meCallCount).toBe(1);
    });

    it('gives each token its own identity inside one window', async () => {
      const buyer = core.accept(token, { id: 4 });
      const organizer = core.accept(otherToken, { id: 2 });

      await post([1], token).expect(201);
      await post([2], otherToken).expect(201);

      expect(core.meCallCount).toBe(2);
      expect((await record(1))?.userId).toBe(buyer.id);
      expect((await record(2))?.userId).toBe(organizer.id);
      expect(buyer.id).not.toBe(organizer.id);
    });
  });

  describe('no token at all', () => {
    it('holds seats as a guest without a user id and without calling core', async () => {
      await post([1]).expect(201);

      const stored = await record(1);

      expect(stored?.sessionId).toBe(session);
      expect(stored === null ? true : 'userId' in stored).toBe(false);
      expect(core.meCallCount).toBe(0);
    });

    it('still holds seats while core is unreachable', async () => {
      core.answerMe('down');

      await post([1]).expect(201);

      expect(core.meCallCount).toBe(0);
    });
  });

  describe('a token core rejects', () => {
    it('refuses the request and writes no hold', async () => {
      core.answerMe('unauthorized');

      const response = await post([1], token).expect(401);

      expect(remember(response.body)).toEqual({
        error: { code: 'UNAUTHENTICATED', message: anyString },
      });
      expect(await heldKeys()).toEqual([]);
    });

    it('does not ask core again on every retry', async () => {
      core.answerMe('unauthorized');

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await post([1], token).expect(401);
      }

      expect(core.meCallCount).toBe(1);
    });

    it.each([
      ['a foreign scheme', 'Banana xyz'],
      ['a bare scheme', 'Bearer'],
      ['an empty credential', 'Bearer '],
      ['a lowercase scheme', `bearer ${MALFORMED_TOKEN}`],
      [
        'two joined headers',
        `Bearer ${MALFORMED_TOKEN}, Bearer ${MALFORMED_TOKEN}`,
      ],
    ])('refuses %s without asking core', async (_label, header) => {
      core.accept(token);

      await post([1]).set('Authorization', header).expect(401);

      expect(core.meCallCount).toBe(0);
      expect(await heldKeys()).toEqual([]);
    });

    it('answers 401 before validating the body', async () => {
      core.answerMe('unauthorized');

      await request(http())
        .post('/holds')
        .set('Authorization', `Bearer ${token}`)
        .send({ event_id: 'nonsense', nope: true })
        .expect(401);
    });
  });

  describe('core unreachable', () => {
    it('serves a cached identity so a brief outage does not take holds down', async () => {
      const user = core.accept(token);

      await post([1], token).expect(201);
      core.answerMe('down');
      await post([2], token).expect(201);

      expect((await record(2))?.userId).toBe(user.id);
    });

    it('refuses a token it has never verified rather than guessing', async () => {
      core.answerMe('down');

      const response = await post([1], token).expect(503);

      expect(remember(response.body)).toEqual({
        error: {
          code: 'AUTH_STATE_UNAVAILABLE',
          message: anyString,
        },
      });
      expect(response.body).not.toHaveProperty('error.details');
      expect(await heldKeys()).toEqual([]);
    });

    it('treats a broken core as unverifiable, not as a rejection, and retries', async () => {
      core.answerMe('broken');

      await post([1], token).expect(503);
      await post([1], token).expect(503);

      expect(core.meCallCount).toBe(2);
    });
  });

  describe('DELETE /holds', () => {
    it('releases the seats of an authenticated caller', async () => {
      core.accept(token);
      await post([1, 2], token).expect(201);

      await request(http())
        .delete('/holds')
        .set('Authorization', `Bearer ${token}`)
        .send({ event_id: eventId, seat_ids: [1, 2], session_id: session })
        .expect(204);

      expect(await heldKeys()).toEqual([]);
    });

    it('refuses a rejected token and leaves the seats held', async () => {
      core.accept(token);
      await post([1, 2], token).expect(201);
      core.answerMe('unauthorized');

      await request(http())
        .delete('/holds')
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ event_id: eventId, seat_ids: [1, 2], session_id: session })
        .expect(401);

      expect((await heldKeys()).length).toBe(2);
    });
  });

  describe('the guard is per route', () => {
    it('ignores a garbage token on the public live-seats route', async () => {
      core.serve([]);

      await request(http())
        .get(`/events/${String(eventId)}/live-seats`)
        .set('Authorization', 'Banana xyz')
        .expect(200);

      expect(core.meCallCount).toBe(0);
    });
  });

  describe('credential hygiene', () => {
    it('never puts a token in a log line or an error body', async () => {
      const rejected = `SENTINEL-REJECTED-${randomUUID()}`;
      const unverifiable = `SENTINEL-UNVERIFIABLE-${randomUUID()}`;

      core.answerMe('unauthorized');
      await post([1], rejected).expect(401);

      core.answerMe('down');
      const failed = await post([2], unverifiable).expect(503);
      remember(failed.body);

      expect(logged.length).toBeGreaterThan(0);
      expect(seenBodies.length).toBeGreaterThan(0);
      expect(logged.join('\n')).toContain('/holds');
      const everything = JSON.stringify([...logged, ...seenBodies]);

      expect(everything.includes(rejected)).toBe(false);
      expect(everything.includes(unverifiable)).toBe(false);
    });
  });
});
