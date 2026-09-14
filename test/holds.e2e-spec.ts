import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request, { Response } from 'supertest';
import { App } from 'supertest/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/http-exception.filter';
import { buildOpenApiDocument } from '../src/swagger';

const SESSION_ID = '0b5f9d6e-3b4a-4c2d-8e1f-7a6b5c4d3e2f';
const INTERNAL_TOKEN = 'e2e-internal-token';
const INTERNAL_HEADER = 'X-Internal-Token';
const SOLD_SEAT_IDS = [3, 7, 11];
const HELD_SEAT_IDS = [5, 9];

const anyString = expect.any(String) as string;

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
  const originalToken = process.env.INTERNAL_TOKEN;

  const http = (): App => app.getHttpServer();

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
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INTERNAL_TOKEN = INTERNAL_TOKEN;
  });

  afterAll(async () => {
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
      const response = await authorized(
        `event_id=1&seat_ids=1&seat_ids=2&session_id=${SESSION_ID}`,
      ).expect(200);

      expect(bodyOf(response)).toEqual({ valid: true, missing: [] });
    });

    it('accepts a single seat_ids value as a one-element array', async () => {
      const response = await authorized(
        `event_id=1&seat_ids=7&session_id=${SESSION_ID}`,
      ).expect(200);

      expect(bodyOf(response)).toEqual({ valid: false, missing: [7] });
    });

    it('accepts a single seat_ids value the session does hold', async () => {
      const response = await authorized(
        `event_id=1&seat_ids=1&session_id=${SESSION_ID}`,
      ).expect(200);

      expect(bodyOf(response)).toEqual({ valid: true, missing: [] });
    });

    it('accepts the repeated seat_ids form as a multi-element array', async () => {
      const response = await authorized(
        `event_id=1&seat_ids=3&seat_ids=4&session_id=${SESSION_ID}`,
      ).expect(200);

      expect(bodyOf(response)).toEqual({ valid: false, missing: [3] });
    });

    it('lists only the seats the session does not hold in missing', async () => {
      const response = await authorized(
        `event_id=1&seat_ids=1&seat_ids=3&seat_ids=7&session_id=${SESSION_ID}`,
      ).expect(200);

      expect(bodyOf(response)).toEqual({ valid: false, missing: [3, 7] });
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
      event_id: 1,
      seat_ids: [1, 2],
      session_id: SESSION_ID,
      ...overrides,
    });

    it('acquires free seats and returns 201 with an empty body', async () => {
      const response = await request(http())
        .post('/holds')
        .send(body())
        .expect(201);

      expect(response.text).toBe('');
    });

    it('returns 409 SEATS_CONFLICT listing only the conflicting seats', async () => {
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

    it('names the conflict detail key conflicting_seat_ids', async () => {
      const response = await request(http())
        .post('/holds')
        .send(body({ seat_ids: [11] }))
        .expect(409);

      expect(bodyOf(response)).toHaveProperty(
        'error.details.conflicting_seat_ids',
        [11],
      );
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
      const response = await request(http())
        .delete('/holds')
        .send({ event_id: 1, seat_ids: [1, 2], session_id: SESSION_ID })
        .expect(204);

      expect(response.text).toBe('');
    });

    it('returns 204 for seats the session does not own rather than an error', async () => {
      const response = await request(http())
        .delete('/holds')
        .send({
          event_id: 1,
          seat_ids: SOLD_SEAT_IDS,
          session_id: '11111111-2222-4333-8444-555555555555',
        })
        .expect(204);

      expect(response.text).toBe('');
    });

    it('returns 204 when the same release is repeated', async () => {
      const payload = {
        event_id: 1,
        seat_ids: [1],
        session_id: SESSION_ID,
      };

      await request(http()).delete('/holds').send(payload).expect(204);
      await request(http()).delete('/holds').send(payload).expect(204);
    });

    it('rejects an unknown property in the body with 400', async () => {
      const response = await request(http())
        .delete('/holds')
        .send({
          event_id: 1,
          seat_ids: [1],
          session_id: SESSION_ID,
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
