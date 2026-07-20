import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { CONSUMER_TOPOLOGY } from '../src/consumer/topology';
import { applyCors } from '../src/cors';
import {
  deleteTopology,
  throwawayTopology,
} from './support/throwaway-topology';

const WEB = 'http://localhost:5173';
const SECOND_WEB = 'https://seatly.test';
const EVIL = 'http://evil.test';
const HANDSHAKE = '/socket.io/?EIO=4&transport=polling';

const topology = throwawayTopology('cors');

describe('CORS for the web origin (e2e)', () => {
  let app: INestApplication<App>;

  const preflight = (origin: string) =>
    request(app.getHttpServer())
      .options('/holds')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set(
        'Access-Control-Request-Headers',
        'authorization,content-type,x-request-id',
      );

  const handshake = (origin: string) =>
    request(app.getHttpServer()).get(HANDSHAKE).set('Origin', origin);

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CONSUMER_TOPOLOGY)
      .useValue(topology)
      .compile();

    app = moduleRef.createNestApplication();
    applyCors(app, [WEB, SECOND_WEB]);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await deleteTopology(topology);
  });

  it('answers a preflight from the web origin with that origin and every header it sends', async () => {
    const response = await preflight(WEB).expect(204);

    expect(response.headers['access-control-allow-origin']).toBe(WEB);
    expect(
      response.headers['access-control-allow-headers'].toLowerCase().split(','),
    ).toEqual(
      expect.arrayContaining(['authorization', 'content-type', 'x-request-id']),
    );
    expect(response.headers['access-control-allow-methods'].split(',')).toEqual(
      expect.arrayContaining(['GET', 'POST', 'DELETE']),
    );
    expect(
      response.headers['access-control-allow-credentials'],
    ).toBeUndefined();
  });

  it('allows every origin in the list, not only the first', async () => {
    const preflightResponse = await preflight(SECOND_WEB).expect(204);
    const handshakeResponse = await handshake(SECOND_WEB).expect(200);

    expect(preflightResponse.headers['access-control-allow-origin']).toBe(
      SECOND_WEB,
    );
    expect(handshakeResponse.headers['access-control-allow-origin']).toBe(
      SECOND_WEB,
    );
  });

  it('gives a preflight from any other origin no allow-origin header', async () => {
    const response = await preflight(EVIL);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets the web origin read the socket.io polling handshake', async () => {
    const response = await handshake(WEB).expect(200);

    expect(response.headers['access-control-allow-origin']).toBe(WEB);
    expect(response.text).toContain('"sid"');
  });

  it('gives the polling handshake from any other origin no allow-origin header', async () => {
    const response = await handshake(EVIL);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
