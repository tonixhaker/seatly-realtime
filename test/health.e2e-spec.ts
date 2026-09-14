import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { validateEnv } from '../src/env.schema';
import { HealthModule } from '../src/health/health.module';
import { HealthService } from '../src/health/health.service';
import { HttpExceptionFilter } from '../src/http-exception.filter';

const CLOSED_REDIS_PORT = '59321';
const CLOSED_AMQP_URL = 'amqp://seatly:seatly@127.0.0.1:59322';

const liveEnv = (): Record<string, string> => ({
  PORT: '3000',
  INTERNAL_TOKEN: 'e2e-internal-token',
  REDIS_HOST: process.env.REDIS_HOST as string,
  REDIS_PORT: process.env.REDIS_PORT as string,
  RABBITMQ_URL: process.env.RABBITMQ_URL as string,
});

const landmine = {
  check: () => {
    throw new Error('liveness touched a readiness dependency');
  },
};

const buildApp = async (
  env: Record<string, string>,
  useLandmine = false,
): Promise<INestApplication<App>> => {
  const builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        validate: () => validateEnv(env),
      }),
      HealthModule,
    ],
  });

  if (useLandmine) {
    builder.overrideProvider(HealthService).useValue(landmine);
  }

  const moduleRef: TestingModule = await builder.compile();
  const app: INestApplication<App> = moduleRef.createNestApplication<App>();
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  return app;
};

describe('Health probes (e2e)', () => {
  describe('against reachable Redis and RabbitMQ', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      app = await buildApp(liveEnv());
    });

    afterAll(async () => {
      await app.close();
    });

    it('reports readiness as ok with every check passing', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(200);

      expect(response.body).toEqual({
        status: 'ok',
        checks: { redis: 'ok', rabbitmq: 'ok' },
      });
    });

    it('answers liveness with no checks key, because it checks nothing', async () => {
      const response = await request(app.getHttpServer())
        .get('/health/live')
        .expect(200);

      expect(response.body).toEqual({ status: 'ok' });
    });

    it('serves both probes without any credential or header', async () => {
      await request(app.getHttpServer()).get('/health').set('Accept', '');
      await request(app.getHttpServer())
        .get('/health/live')
        .set('Accept', '')
        .expect(200);
    });
  });

  describe('with Redis unreachable', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      app = await buildApp({ ...liveEnv(), REDIS_PORT: CLOSED_REDIS_PORT });
    });

    afterAll(async () => {
      await app.close();
    });

    it('answers readiness with 503 and names redis as the failing check', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(503);

      expect(response.body).toEqual({
        status: 'error',
        checks: { redis: 'error', rabbitmq: 'ok' },
      });
    });

    it('keeps the status-report shape and never the error envelope', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(503);

      expect(response.body).not.toHaveProperty('error');
      expect(response.headers['content-type']).toMatch(/application\/json/);
    });

    it('leaks neither the host, the port nor the driver message', async () => {
      const response = await request(app.getHttpServer()).get('/health');

      expect(JSON.stringify(response.body)).not.toMatch(
        /127\.0\.0\.1|ECONNREFUSED|59321|Stream/i,
      );
    });

    it('still answers liveness with 200 while readiness is failing', async () => {
      await request(app.getHttpServer()).get('/health/live').expect(200);
    });
  });

  describe('with RabbitMQ unreachable', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      app = await buildApp({ ...liveEnv(), RABBITMQ_URL: CLOSED_AMQP_URL });
    });

    afterAll(async () => {
      await app.close();
    });

    it('answers readiness with 503 and names rabbitmq as the failing check', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(503);

      expect(response.body).toEqual({
        status: 'error',
        checks: { redis: 'ok', rabbitmq: 'error' },
      });
    });

    it('still answers liveness with 200 while readiness is failing', async () => {
      await request(app.getHttpServer()).get('/health/live').expect(200);
    });
  });

  describe('liveness is structurally free of both dependencies', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      app = await buildApp(liveEnv(), true);
    });

    afterAll(async () => {
      await app.close();
    });

    it('answers liveness with 200 though every readiness dependency throws on touch', async () => {
      const response = await request(app.getHttpServer())
        .get('/health/live')
        .expect(200);

      expect(response.body).toEqual({ status: 'ok' });
    });

    it('proves the double is armed by failing readiness on the same fixture', async () => {
      await request(app.getHttpServer()).get('/health').expect(500);
    });
  });

  describe('as mounted in the application Compose actually runs', () => {
    let app: INestApplication<App>;

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

    afterAll(async () => {
      await app.close();
    });

    it('serves liveness from AppModule with no credential and no header', async () => {
      const response = await request(app.getHttpServer())
        .get('/health/live')
        .expect(200);

      expect(response.body).toEqual({ status: 'ok' });
    });

    it('serves readiness from AppModule with no credential and no header', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(200);

      expect(response.body).toEqual({
        status: 'ok',
        checks: { redis: 'ok', rabbitmq: 'ok' },
      });
    });
  });
});
