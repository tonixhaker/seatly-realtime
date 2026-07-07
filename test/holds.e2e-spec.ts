import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request, { Response } from 'supertest';
import { App } from 'supertest/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/http-exception.filter';
import { buildOpenApiDocument } from '../src/swagger';

const SESSION_ID = '0b5f9d6e-3b4a-4c2d-8e1f-7a6b5c4d3e2f';
const INTERNAL_TOKEN = 'e2e-internal-token';
const INTERNAL_HEADER = 'X-Internal-Token';
const SOLD_SEAT_IDS = [3, 7, 11];
const HELD_SEAT_IDS = [5, 9];
const BASE_EVENT_ID = 700000 + Math.floor(Math.random() * 90000);

const anyString = expect.any(String) as string;

const byId = (a: number, b: number): number => a - b;

const seenBodies: unknown[] = [];

const bodyOf = (response: Response): unknown => {
  const body = response.body as unknown;
  seenBodies.push(body);
  return body;
};

const containsKey = (value: unknown, key: string): boolean => {
  if (Array.isArray(value)) {
    return (value as unknown[]).some((item) => containsKey(item, key));
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return (
      key in record ||
      Object.values(record).some((item) => containsKey(item, key))
    );
  }
  return false;
};

describe('Holds REST surface (e2e)', () => {
  let app: INestApplication<App>;
  let redis: Redis;
  let eventId: number;
  let mine: string;
  let theirs: string;
  let nextEventId = BASE_EVENT_ID;
  const originalToken = process.env.INTERNAL_TOKEN;

  const http = (): App => app.getHttpServer();

  const holdKeys = async (): Promise<string[]> =>
    (await redis.keys(`hold:${eventId}:*`)).sort();

  const ownerOf = async (seatId: number): Promise<string | undefined> => {
    const raw = await redis.get(`hold:${eventId}:${seatId}`);
    return raw === null
      ? undefined
      : (JSON.parse(raw) as { sessionId: string }).sessionId;
  };

  const hold = (seatIds: number[], sessionId: string) =>
    request(http())
      .post('/holds')
      .send({ event_id: eventId, seat_ids: seatIds, session_id: sessionId })
      .expect(201);

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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

    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INTERNAL_TOKEN = INTERNAL_TOKEN;
    eventId = ++nextEventId;
    mine = randomUUID();
    theirs = randomUUID();
  });

  afterEach(async () => {
    const keys = await redis.keys(`hold:${eventId}:*`);
    await redis.del(...keys, `session:${mine}`, `session:${theirs}`);
  });

  afterAll(async () => {
    await redis.quit();
    if (originalToken === undefined) {
      delete process.env.INTERNAL_TOKEN;
    } else {
      process.env.INTERNAL_TOKEN = originalToken;
    }
    await app.close();
  });

  describe('GET /internal/holds/validate authorization', () => {
    const query = `event_id=1&seat_ids=1&session_id=${SESSION_ID}`;

    it('rejects a request carrying no X-Internal-Token header with 401', async () => {
      const response = await request(http())
        .get(`/internal/holds/validate?${query}`)
        .expect(401);

      expect(bodyOf(response)).toEqual({
        error: { code: 'UNAUTHENTICATED', message: anyString },
      });
    });

    it('rejects a request carrying a wrong X-Internal-Token with 401', async () => {
      const response = await request(http())
        .get(`/internal/holds/validate?${query}`)
        .set(INTERNAL_HEADER, 'not-the-token')
        .expect(401);

      expect(bodyOf(response)).toEqual({
        error: { code: 'UNAUTHENTICATED', message: anyString },
      });
    });

    it('omits the details key entirely from the 401 envelope', async () => {
      const response = await request(http())
        .get(`/internal/holds/validate?${query}`)
        .expect(401);

      expect(bodyOf(response)).not.toHaveProperty('error.details');
    });

    it('fails closed with 401 when INTERNAL_TOKEN is unset in the environment', async () => {
      delete process.env.INTERNAL_TOKEN;

      const response = await request(http())
        .get(`/internal/holds/validate?${query}`)
        .set(INTERNAL_HEADER, INTERNAL_TOKEN)
        .expect(401);

      expect(bodyOf(response)).toEqual({
        error: { code: 'UNAUTHENTICATED', message: anyString },
      });
    });

    it('fails closed with 401 when INTERNAL_TOKEN is an empty string', async () => {
      process.env.INTERNAL_TOKEN = '';

      const response = await request(http())
        .get(`/internal/holds/validate?${query}`)
        .set(INTERNAL_HEADER, '')
        .expect(401);

      expect(bodyOf(response)).toEqual({
        error: { code: 'UNAUTHENTICATED', message: anyString },
      });
    });

    it('rejects an unauthenticated request with 401 before validating its query', async () => {
      const response = await request(http())
        .get('/internal/holds/validate?nonsense=1')
        .expect(401);

      expect(bodyOf(response)).toEqual({
        error: { code: 'UNAUTHENTICATED', message: anyString },
      });
    });
  });

  describe('GET /internal/holds/validate', () => {
    const authorized = (query: string) =>
      request(http())
        .get(`/internal/holds/validate?${query}`)
        .set(INTERNAL_HEADER, INTERNAL_TOKEN);

    it('reports the session as valid when it holds every requested seat', async () => {
      await hold([1, 2], mine);

      const response = await authorized(
        `event_id=${eventId}&seat_ids=1&seat_ids=2&session_id=${mine}`,
      ).expect(200);

      expect(bodyOf(response)).toEqual({ valid: true, missing: [] });
    });

    it('accepts a single seat_ids value as a one-element array', async () => {
      const response = await authorized(
        `event_id=${eventId}&seat_ids=7&session_id=${mine}`,
      ).expect(200);

      expect(bodyOf(response)).toEqual({ valid: false, missing: [7] });
    });

    it('accepts a single seat_ids value the session does hold', async () => {
      await hold([1], mine);

      const response = await authorized(
        `event_id=${eventId}&seat_ids=1&session_id=${mine}`,
      ).expect(200);

      expect(bodyOf(response)).toEqual({ valid: true, missing: [] });
    });

    it('accepts the repeated seat_ids form as a multi-element array', async () => {
      await hold([4], mine);

      const response = await authorized(
        `event_id=${eventId}&seat_ids=3&seat_ids=4&session_id=${mine}`,
      ).expect(200);

      expect(bodyOf(response)).toEqual({ valid: false, missing: [3] });
    });

    it('lists only the seats the session does not hold in missing', async () => {
      await hold([1], mine);

      const response = await authorized(
        `event_id=${eventId}&seat_ids=1&seat_ids=3&seat_ids=7&session_id=${mine}`,
      ).expect(200);

      expect(bodyOf(response)).toEqual({ valid: false, missing: [3, 7] });
    });

    it('calls a seat held by another session missing rather than valid', async () => {
      await hold([1, 2], theirs);

      const response = await authorized(
        `event_id=${eventId}&seat_ids=1&seat_ids=2&session_id=${mine}`,
      ).expect(200);

      expect(bodyOf(response)).toEqual({ valid: false, missing: [1, 2] });
    });

    it('does not carry a hold at one event over to another event', async () => {
      await hold([1], mine);
      const otherEvent = eventId + 500000;

      const response = await authorized(
        `event_id=${otherEvent}&seat_ids=1&session_id=${mine}`,
      ).expect(200);

      expect(bodyOf(response)).toEqual({ valid: false, missing: [1] });
    });

    it('reports a seat whose hold key has gone as missing', async () => {
      await hold([1, 2], mine);
      await redis.del(`hold:${eventId}:1`);

      const response = await authorized(
        `event_id=${eventId}&seat_ids=1&seat_ids=2&session_id=${mine}`,
      ).expect(200);

      expect(bodyOf(response)).toEqual({ valid: false, missing: [1] });
    });

    it('lists missing seats in request order rather than sorted', async () => {
      await hold([2], mine);

      const response = await authorized(
        `event_id=${eventId}&seat_ids=9&seat_ids=2&seat_ids=4&session_id=${mine}`,
      ).expect(200);

      expect(bodyOf(response)).toEqual({ valid: false, missing: [9, 4] });
    });

    it('rejects a query missing seat_ids with 400', async () => {
      const response = await authorized(
        `event_id=1&session_id=${SESSION_ID}`,
      ).expect(400);

      expect(bodyOf(response)).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    });

    it('rejects a non-UUID session_id with 400', async () => {
      const response = await authorized(
        'event_id=1&seat_ids=1&session_id=not-a-uuid',
      ).expect(400);

      expect(bodyOf(response)).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    });

    it('rejects an unknown query parameter with 400', async () => {
      const response = await authorized(
        `event_id=1&seat_ids=1&session_id=${SESSION_ID}&sneaky=1`,
      ).expect(400);

      expect(bodyOf(response)).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    });

    it('rejects duplicate ids in seat_ids with 400', async () => {
      const response = await authorized(
        `event_id=1&seat_ids=4&seat_ids=4&session_id=${SESSION_ID}`,
      ).expect(400);

      expect(bodyOf(response)).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    });
  });

  describe('POST /holds', () => {
    const body = (overrides: Record<string, unknown> = {}) => ({
      event_id: eventId,
      seat_ids: [1, 2],
      session_id: mine,
      ...overrides,
    });

    it('acquires free seats and returns 201 with an empty body', async () => {
      const response = await request(http())
        .post('/holds')
        .send(body({ seat_ids: [1, 2, 4] }))
        .expect(201);

      expect(response.text).toBe('');
      expect(await holdKeys()).toEqual([
        `hold:${eventId}:1`,
        `hold:${eventId}:2`,
        `hold:${eventId}:4`,
      ]);
      expect(await ownerOf(1)).toBe(mine);
      expect(await ownerOf(4)).toBe(mine);
      expect((await redis.smembers(`session:${mine}`)).sort()).toEqual([
        '1',
        '2',
        '4',
      ]);
      expect(await redis.ttl(`hold:${eventId}:1`)).toBeGreaterThanOrEqual(599);
      expect(await redis.ttl(`hold:${eventId}:1`)).toBeLessThanOrEqual(600);
    });

    it('returns 409 SEATS_CONFLICT listing only the conflicting seats', async () => {
      await hold([3, 7], theirs);

      const response = await request(http())
        .post('/holds')
        .send(body({ seat_ids: [1, 3, 7] }))
        .expect(409);

      expect(bodyOf(response)).toEqual({
        error: {
          code: 'SEATS_CONFLICT',
          message: anyString,
          details: { conflicting_seat_ids: [3, 7] },
        },
      });
    });

    it('leaves the loser its own non-overlapping seats unheld and the winner untouched', async () => {
      await hold([3, 7], theirs);

      await request(http())
        .post('/holds')
        .send(body({ seat_ids: [1, 3, 5, 7, 9] }))
        .expect(409);

      expect(await holdKeys()).toEqual([
        `hold:${eventId}:3`,
        `hold:${eventId}:7`,
      ]);
      expect(await ownerOf(3)).toBe(theirs);
      expect(await ownerOf(7)).toBe(theirs);
      expect(await redis.exists(`session:${mine}`)).toBe(0);
      expect((await redis.smembers(`session:${theirs}`)).sort()).toEqual([
        '3',
        '7',
      ]);
    });

    it('names the conflicting seats in request order rather than sorted', async () => {
      await hold([2, 8], theirs);

      const response = await request(http())
        .post('/holds')
        .send(body({ seat_ids: [8, 5, 2] }))
        .expect(409);

      expect(bodyOf(response)).toHaveProperty(
        'error.details.conflicting_seat_ids',
        [8, 2],
      );
    });

    it('names the conflict detail key conflicting_seat_ids', async () => {
      await hold([11], theirs);

      const response = await request(http())
        .post('/holds')
        .send(body({ seat_ids: [11] }))
        .expect(409);

      expect(bodyOf(response)).toHaveProperty(
        'error.details.conflicting_seat_ids',
        [11],
      );
    });

    it('answers 201 when the same session re-posts seats it already holds', async () => {
      await hold([1, 2], mine);
      const heldAt = await redis.get(`hold:${eventId}:1`);

      await request(http())
        .post('/holds')
        .send(body({ seat_ids: [1, 2, 3] }))
        .expect(201);

      expect(await redis.get(`hold:${eventId}:1`)).toBe(heldAt);
      expect((await redis.smembers(`session:${mine}`)).sort()).toEqual([
        '1',
        '2',
        '3',
      ]);
    });

    it('holds a request of exactly the maximum allowed seat count and validates it', async () => {
      const seatIds = Array.from({ length: 50 }, (_, i) => i + 1);

      await request(http())
        .post('/holds')
        .send(body({ seat_ids: seatIds }))
        .expect(201);

      expect(await holdKeys()).toHaveLength(50);
      expect(
        (await redis.smembers(`session:${mine}`)).map(Number).sort(byId),
      ).toEqual(seatIds);

      const response = await request(http())
        .get('/internal/holds/validate')
        .query({ event_id: eventId, seat_ids: seatIds, session_id: mine })
        .set(INTERNAL_HEADER, INTERNAL_TOKEN)
        .expect(200);

      expect(bodyOf(response)).toEqual({ valid: true, missing: [] });
    });

    it('writes nothing when seat_ids exceeds the allowed maximum', async () => {
      const response = await request(http())
        .post('/holds')
        .send(body({ seat_ids: Array.from({ length: 51 }, (_, i) => i + 1) }))
        .expect(400);

      expect(bodyOf(response)).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
      expect(await holdKeys()).toEqual([]);
      expect(await redis.exists(`session:${mine}`)).toBe(0);
    });

    it('rejects an unknown property in the body with 400', async () => {
      const response = await request(http())
        .post('/holds')
        .send(body({ hold_ttl: 300 }))
        .expect(400);

      expect(bodyOf(response)).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    });

    it('rejects a non-UUID session_id with 400', async () => {
      const response = await request(http())
        .post('/holds')
        .send(body({ session_id: 'session-42' }))
        .expect(400);

      expect(bodyOf(response)).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    });

    it('rejects duplicate ids in seat_ids with 400', async () => {
      const response = await request(http())
        .post('/holds')
        .send(body({ seat_ids: [4, 4] }))
        .expect(400);

      expect(bodyOf(response)).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    });

    it('rejects an empty seat_ids array with 400', async () => {
      const response = await request(http())
        .post('/holds')
        .send(body({ seat_ids: [] }))
        .expect(400);

      expect(bodyOf(response)).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    });

    it('rejects a missing event_id with 400', async () => {
      const response = await request(http())
        .post('/holds')
        .send({ seat_ids: [1], session_id: SESSION_ID })
        .expect(400);

      expect(bodyOf(response)).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    });

    it('rejects an empty body with 400', async () => {
      const response = await request(http())
        .post('/holds')
        .send({})
        .expect(400);

      expect(bodyOf(response)).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    });
  });

  describe('DELETE /holds', () => {
    it('releases the session own seats and returns 204 with no body', async () => {
      await hold([1, 2, 4], mine);

      const response = await request(http())
        .delete('/holds')
        .send({ event_id: eventId, seat_ids: [1, 2], session_id: mine })
        .expect(204);

      expect(response.text).toBe('');
      expect(await holdKeys()).toEqual([`hold:${eventId}:4`]);
      expect(await redis.smembers(`session:${mine}`)).toEqual(['4']);
    });

    it('drops the session entry once its last seat is released', async () => {
      await hold([1, 2], mine);

      await request(http())
        .delete('/holds')
        .send({ event_id: eventId, seat_ids: [1, 2], session_id: mine })
        .expect(204);

      expect(await holdKeys()).toEqual([]);
      expect(await redis.exists(`session:${mine}`)).toBe(0);
    });

    it('returns 204 for seats the session does not own rather than an error', async () => {
      await hold([1, 2], theirs);
      const payload = await redis.get(`hold:${eventId}:1`);
      const ttl = await redis.ttl(`hold:${eventId}:1`);

      const response = await request(http())
        .delete('/holds')
        .send({ event_id: eventId, seat_ids: [1, 2], session_id: mine })
        .expect(204);

      expect(response.text).toBe('');
      expect(await holdKeys()).toEqual([
        `hold:${eventId}:1`,
        `hold:${eventId}:2`,
      ]);
      expect(await redis.get(`hold:${eventId}:1`)).toBe(payload);
      expect(await redis.ttl(`hold:${eventId}:1`)).toBeGreaterThanOrEqual(
        ttl - 1,
      );
      expect((await redis.smembers(`session:${theirs}`)).sort()).toEqual([
        '1',
        '2',
      ]);
    });

    it('returns 204 when the same release is repeated', async () => {
      await hold([1], mine);
      const payload = {
        event_id: eventId,
        seat_ids: [1],
        session_id: mine,
      };

      await request(http()).delete('/holds').send(payload).expect(204);
      expect(await holdKeys()).toEqual([]);

      await request(http()).delete('/holds').send(payload).expect(204);
      expect(await holdKeys()).toEqual([]);
    });

    it('rejects an unknown property in the body with 400', async () => {
      const response = await request(http())
        .delete('/holds')
        .send({
          event_id: eventId,
          seat_ids: [1],
          session_id: mine,
          force: true,
        })
        .expect(400);

      expect(bodyOf(response)).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    });

    it('rejects a non-UUID session_id with 400', async () => {
      const response = await request(http())
        .delete('/holds')
        .send({ event_id: 1, seat_ids: [1], session_id: '1' })
        .expect(400);

      expect(bodyOf(response)).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    });
  });

  describe('GET /events/:id/live-seats', () => {
    it('returns the held and sold snapshot for the event', async () => {
      const response = await request(http())
        .get('/events/1/live-seats')
        .expect(200);

      expect(bodyOf(response)).toEqual({
        held: HELD_SEAT_IDS,
        sold: SOLD_SEAT_IDS,
      });
    });

    it('rejects a non-numeric event id with 400 in the shared envelope', async () => {
      const response = await request(http())
        .get('/events/abc/live-seats')
        .expect(400);

      expect(bodyOf(response)).toMatchObject({
        error: {
          code: 'VALIDATION_FAILED',
          message: anyString,
          details: { errors: expect.any(Array) as string[] },
        },
      });
    });
  });

  describe('error envelope', () => {
    it('answers an unknown route with 404 in the shared envelope', async () => {
      const response = await request(http()).get('/does-not-exist').expect(404);

      expect(bodyOf(response)).toEqual({
        error: { code: 'NOT_FOUND', message: anyString },
      });
    });

    it('omits the details key entirely from the 404 envelope', async () => {
      const response = await request(http()).get('/does-not-exist').expect(404);

      expect(bodyOf(response)).not.toHaveProperty('error.details');
    });

    it('never leaks the Nest default statusCode key in any response of this suite', () => {
      expect(seenBodies.length).toBeGreaterThan(0);
      expect(
        seenBodies.filter((body) => containsKey(body, 'statusCode')),
      ).toEqual([]);
    });
  });
  describe('OpenAPI document', () => {
    const committed = (): unknown =>
      JSON.parse(
        readFileSync(join(__dirname, '..', 'docs', 'openapi.json'), 'utf8'),
      ) as unknown;

    it('documents all four routes', () => {
      const document = buildOpenApiDocument(app);

      expect(Object.keys(document.paths).sort()).toEqual([
        '/events/{id}/live-seats',
        '/holds',
        '/internal/holds/validate',
      ]);
      expect(document.paths['/holds'].post).toBeDefined();
      expect(document.paths['/holds'].delete).toBeDefined();
    });

    it('marks the internal route distinctly and leaves the public ones unmarked', () => {
      const document = buildOpenApiDocument(app);
      const internal = document.paths['/internal/holds/validate'].get;
      const publicOperation = document.paths['/holds'].post;

      expect(internal).toMatchObject({
        tags: expect.arrayContaining(['internal']) as string[],
        security: [{ 'internal-token': [] }],
        'x-internal': true,
      });
      expect(publicOperation).not.toHaveProperty('x-internal');
      expect(publicOperation).not.toHaveProperty('security');
    });

    it('documents the 409 conflict body as a named schema carrying conflicting_seat_ids', () => {
      const document = buildOpenApiDocument(app);

      expect(document.paths['/holds'].post?.responses['409']).toMatchObject({
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SeatsConflictResponseDto' },
          },
        },
      });
      expect(
        document.components?.schemas?.SeatsConflictDetailsDto,
      ).toMatchObject({
        properties: { conflicting_seat_ids: { type: 'array' } },
        required: ['conflicting_seat_ids'],
      });
    });

    it('matches the committed docs/openapi.json', () => {
      expect(committed()).toEqual(
        JSON.parse(JSON.stringify(buildOpenApiDocument(app))) as unknown,
      );
    });
  });
  describe('input hardening', () => {
    const NON_INTEGER_IDS = [
      '-1',
      '0',
      '1e3',
      '0x10',
      '0b11',
      '%201',
      '1.5',
      '01',
    ];
    const UNSAFE_ID = '9007199254740993';

    it.each([...NON_INTEGER_IDS, UNSAFE_ID])(
      'rejects the event id %s in the live-seats path with 400',
      async (id) => {
        const response = await request(http())
          .get(`/events/${id}/live-seats`)
          .expect(400);

        expect(bodyOf(response)).toMatchObject({
          error: { code: 'VALIDATION_FAILED' },
        });
      },
    );

    it.each([...NON_INTEGER_IDS, UNSAFE_ID, 'abc'])(
      'rejects the seat id %s in the validate query with 400',
      async (id) => {
        const response = await request(http())
          .get('/internal/holds/validate')
          .set(INTERNAL_HEADER, INTERNAL_TOKEN)
          .query({ event_id: 1, seat_ids: id, session_id: SESSION_ID })
          .expect(400);

        expect(bodyOf(response)).toMatchObject({
          error: { code: 'VALIDATION_FAILED' },
        });
      },
    );

    it.each(['0x10', '1e3', '0', ''])(
      'rejects the event_id %s in the validate query with 400',
      async (id) => {
        const response = await request(http())
          .get('/internal/holds/validate')
          .set(INTERNAL_HEADER, INTERNAL_TOKEN)
          .query({ event_id: id, seat_ids: 1, session_id: SESSION_ID })
          .expect(400);

        expect(bodyOf(response)).toMatchObject({
          error: { code: 'VALIDATION_FAILED' },
        });
      },
    );

    it('rejects a body seat id above Number.MAX_SAFE_INTEGER with 400', async () => {
      const response = await request(http())
        .post('/holds')
        .send({
          event_id: 1,
          seat_ids: [Number.MAX_SAFE_INTEGER + 2],
          session_id: SESSION_ID,
        })
        .expect(400);

      expect(bodyOf(response)).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    });

    it('rejects a body event_id above Number.MAX_SAFE_INTEGER with 400', async () => {
      const response = await request(http())
        .post('/holds')
        .send({
          event_id: Number.MAX_SAFE_INTEGER + 2,
          seat_ids: [1],
          session_id: SESSION_ID,
        })
        .expect(400);

      expect(bodyOf(response)).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    });

    it('answers a body larger than the parser limit with 413 in the shared envelope', async () => {
      const response = await request(http())
        .post('/holds')
        .set('Content-Type', 'application/json')
        .send(
          JSON.stringify({
            event_id: 1,
            seat_ids: [1],
            session_id: SESSION_ID,
            padding: 'A'.repeat(200_000),
          }),
        )
        .expect(413);

      expect(bodyOf(response)).toEqual({
        error: { code: 'PAYLOAD_TOO_LARGE', message: anyString },
      });
    });

    it('answers an unsupported content type with 415 in the shared envelope', async () => {
      const response = await request(http())
        .post('/holds')
        .set('Content-Type', 'application/json; charset=utf-99')
        .send('{}')
        .expect(415);

      expect(bodyOf(response)).toEqual({
        error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: anyString },
      });
    });
  });
});
