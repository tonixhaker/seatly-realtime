import { randomBytes } from 'node:crypto';
import { request as httpRequest, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import { io, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { CONSUMER_TOPOLOGY } from '../src/consumer/topology';
import { applyCors } from '../src/cors';
import { soldWarmKey } from '../src/redis/keys';
import {
  deleteTopology,
  throwawayTopology,
} from './support/throwaway-topology';

jest.setTimeout(30000);

const WEB = 'http://localhost:5173';
const SECOND_WEB = 'https://seatly.test';
const EVIL = 'http://evil.test';
const HANDSHAKE = '/socket.io/?EIO=4&transport=polling';
const WS_HANDSHAKE = '/socket.io/?EIO=4&transport=websocket';
const TRANSPORTS = ['polling', 'websocket'] as const;
const WAIT_TIMEOUT_MS = 8000;

const BASE_EVENT_ID = 100000 + Math.floor(Math.random() * 80000);

const topology = throwawayTopology('cors');

type Transport = (typeof TRANSPORTS)[number];

interface UpgradeResult {
  upgraded: boolean;
  status: number;
}

describe('CORS for the web origin (e2e)', () => {
  let app: INestApplication<App>;
  let redis: Redis;
  let port: number;
  let url: string;
  let eventId: number;
  let nextEventId = BASE_EVENT_ID;
  const sockets: ClientSocket[] = [];

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

  const connectClient = async (
    transport: Transport,
    origin?: string,
  ): Promise<ClientSocket> => {
    const socket = io(`${url}/events`, {
      transports: [transport],
      forceNew: true,
      reconnection: false,
      ...(origin === undefined ? {} : { extraHeaders: { Origin: origin } }),
    });

    sockets.push(socket);

    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => {
        resolve();
      });
      socket.once('connect_error', reject);
    });

    return socket;
  };

  const snapshotAfterJoin = (
    socket: ClientSocket,
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('no snapshot arrived after join'));
      }, WAIT_TIMEOUT_MS);

      socket.once('snapshot', (payload: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(payload);
      });
      socket.emit('join', { event_id: eventId });
    });

  const rawUpgrade = (origin?: string): Promise<UpgradeResult> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const settle = (result: UpgradeResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      const req = httpRequest({
        host: '127.0.0.1',
        port,
        path: WS_HANDSHAKE,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          ...(origin === undefined ? {} : { Origin: origin }),
        },
      });

      req.on('upgrade', (response, socket) => {
        socket.destroy();
        settle({ upgraded: true, status: response.statusCode ?? 0 });
      });
      req.on('response', (response) => {
        response.resume();
        settle({ upgraded: false, status: response.statusCode ?? 0 });
      });
      req.on('error', (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      req.on('close', () => {
        if (!settled) {
          settled = true;
          reject(new Error('the handshake closed with no response'));
        }
      });
      req.end();
    });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CONSUMER_TOPOLOGY)
      .useValue(topology)
      .compile();

    app = moduleRef.createNestApplication();
    applyCors(app, [WEB, SECOND_WEB]);
    await app.listen(0);

    const server = app.getHttpServer() as unknown as Server;

    port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${String(port)}`;

    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
    });
  });

  beforeEach(async () => {
    eventId = ++nextEventId;
    await redis.set(soldWarmKey(eventId), '', 'EX', 60);
  });

  afterEach(async () => {
    for (const socket of sockets) {
      socket.disconnect();
    }

    sockets.length = 0;
    await redis.del(soldWarmKey(eventId));
  });

  afterAll(async () => {
    await redis.quit();
    await app.close();
    await deleteTopology(topology);
  });

  describe('the socket.io handshake from an allowed origin', () => {
    it.each(TRANSPORTS)(
      'connects the web origin over %s and sends it a snapshot on join',
      async (transport) => {
        const socket = await connectClient(transport, WEB);

        expect(await snapshotAfterJoin(socket)).toEqual({
          event_id: eventId,
          held: [],
          sold: [],
        });
      },
    );

    it.each(TRANSPORTS)(
      'connects the second listed origin over %s and sends it a snapshot on join',
      async (transport) => {
        const socket = await connectClient(transport, SECOND_WEB);

        expect(await snapshotAfterJoin(socket)).toEqual({
          event_id: eventId,
          held: [],
          sold: [],
        });
      },
    );

    it.each(TRANSPORTS)(
      'connects a client sending no Origin over %s and sends it a snapshot on join',
      async (transport) => {
        const socket = await connectClient(transport);

        expect(await snapshotAfterJoin(socket)).toEqual({
          event_id: eventId,
          held: [],
          sold: [],
        });
      },
    );

    it('upgrades a raw websocket handshake that sends no Origin', async () => {
      expect(await rawUpgrade()).toEqual({ upgraded: true, status: 101 });
    });

    it('upgrades a raw websocket handshake from the web origin', async () => {
      expect(await rawUpgrade(WEB)).toEqual({ upgraded: true, status: 101 });
    });
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

  describe('the socket.io handshake from a foreign origin', () => {
    it('refuses the polling handshake with 403, no session id and no allow-origin header', async () => {
      const response = await handshake(EVIL).expect(403);

      expect(response.text).not.toContain('sid');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('refuses the raw websocket handshake with 400 and never upgrades', async () => {
      expect(await rawUpgrade(EVIL)).toEqual({ upgraded: false, status: 400 });
    });

    it.each(['', 'null'])(
      'refuses the polling handshake with Origin %p',
      async (origin) => {
        const response = await handshake(origin).expect(403);

        expect(response.text).not.toContain('sid');
      },
    );
  });
});
