import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Logger } from 'nestjs-pino';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { CONSUMER_TOPOLOGY } from '../src/consumer/topology';
import { HttpExceptionFilter } from '../src/http-exception.filter';
import {
  deleteTopology,
  throwawayTopology,
} from './support/throwaway-topology';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LogLine {
  level: number;
  msg: string;
  request_id?: string;
  context?: string;
  res?: { statusCode: number };
}

const topology = throwawayTopology('logging');

describe('Structured logging and request id (e2e)', () => {
  let app: INestApplication<App>;
  const captured: string[] = [];
  let stdout: jest.SpiedFunction<typeof process.stdout.write>;

  const http = (): App => app.getHttpServer();

  const lines = (): LogLine[] =>
    captured
      .join('')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as LogLine);

  const completed = async (id: string): Promise<LogLine> => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const line = lines().find(
        (entry) => entry.request_id === id && entry.msg === 'request completed',
      );
      if (line !== undefined) {
        return line;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no request completed line for ${id}`);
  };

  const validate = () =>
    request(http())
      .get(
        `/internal/holds/validate?event_id=1&seat_ids=1&session_id=${randomUUID()}`,
      )
      .set('X-Internal-Token', process.env.INTERNAL_TOKEN as string);

  beforeAll(async () => {
    stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        captured.push(String(chunk));
        return true;
      });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CONSUMER_TOPOLOGY)
      .useValue(topology)
      .compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get(Logger));
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

  afterAll(async () => {
    await app.close();
    stdout.mockRestore();
    await deleteTopology(topology);
  });

  it('echoes a valid X-Request-Id on POST /holds and logs it as request_id', async () => {
    const id = randomUUID();
    const body = {
      event_id: 900000 + Math.floor(Math.random() * 90000),
      seat_ids: [1],
      session_id: randomUUID(),
    };

    const response = await request(http())
      .post('/holds')
      .set('X-Request-Id', id)
      .send(body)
      .expect(201);

    expect(response.headers['x-request-id']).toBe(id);
    expect((await completed(id)).res).toEqual({ statusCode: 201 });

    await request(http()).delete('/holds').send(body).expect(204);
  });

  it('logs the id core forwards to GET /internal/holds/validate', async () => {
    const id = randomUUID();

    const response = await validate().set('X-Request-Id', id).expect(200);

    expect(response.headers['x-request-id']).toBe(id);
    expect((await completed(id)).res).toEqual({ statusCode: 200 });
  });

  it('carries request_id on the HttpExceptionFilter warn for a 4xx', async () => {
    const id = randomUUID();

    await request(http())
      .post('/holds')
      .set('X-Request-Id', id)
      .send({})
      .expect(400);
    await completed(id);

    expect(lines()).toContainEqual(
      expect.objectContaining({
        context: 'HttpExceptionFilter',
        level: 40,
        request_id: id,
      }),
    );
  });

  it('generates an id when the header is missing', async () => {
    const response = await validate().expect(200);
    const generated = response.headers['x-request-id'];

    expect(generated).toMatch(UUID);
    await completed(generated);
  });

  it.each([
    ['a non-uuid', 'not-a-uuid'],
    ['a 5000-character value', 'a'.repeat(5000)],
  ])(
    'replaces %s with a generated id and never logs it',
    async (_label, supplied) => {
      const response = await validate()
        .set('X-Request-Id', supplied)
        .expect(200);
      const generated = response.headers['x-request-id'];

      expect(generated).toMatch(UUID);
      expect(generated).not.toBe(supplied);
      await completed(generated);
      expect(captured.join('')).not.toContain(supplied);
    },
  );

  it('echoes the id on health probes without logging their completion', async () => {
    const probe = randomUUID();
    const after = randomUUID();

    const response = await request(http())
      .get('/health/live')
      .set('X-Request-Id', probe)
      .expect(200);
    await validate().set('X-Request-Id', after).expect(200);
    await completed(after);

    expect(response.headers['x-request-id']).toBe(probe);
    expect(lines().some((entry) => entry.request_id === probe)).toBe(false);
  });

  it('writes nothing but JSON lines to stdout', () => {
    expect(lines().length).toBeGreaterThan(0);
  });
});
