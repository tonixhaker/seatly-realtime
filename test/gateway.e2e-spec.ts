import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Channel, ChannelModel, connect } from 'amqplib';
import Redis from 'ioredis';
import { io, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { CONSUMER_TOPOLOGY } from '../src/consumer/topology';
import { HttpExceptionFilter } from '../src/http-exception.filter';
import {
  expiryKey,
  holdKey,
  sessionKey,
  soldKey,
  soldWarmKey,
} from '../src/redis/keys';
import {
  deleteTopology,
  throwawayTopology,
} from './support/throwaway-topology';

jest.setTimeout(30000);

const BASE_EVENT_ID = 200000 + Math.floor(Math.random() * 80000);

const WAIT_TIMEOUT_MS = 8000;

const POLL_INTERVAL_MS = 25;

const SETTLE_MS = 400;

const FORCED_TTL_MS = 100;

const topology = throwawayTopology('gateway');

interface Frame {
  name: string;
  payload: Record<string, unknown>;
}

interface Client {
  socket: ClientSocket;
  frames: Frame[];
}

describe('WebSocket gateway (e2e)', () => {
  let app: INestApplication<App>;
  let redis: Redis;
  let model: ChannelModel;
  let channel: Channel;
  let url: string;
  let eventId: number;
  let otherEventId: number;
  let mine: string;
  let theirs: string;
  let nextEventId = BASE_EVENT_ID;
  const clients: Client[] = [];
  const publishedIds: string[] = [];

  const http = (): App => app.getHttpServer();

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const connectClient = async (): Promise<Client> => {
    const socket = io(`${url}/events`, {
      transports: ['websocket'],
      forceNew: true,
    });
    const client: Client = { socket, frames: [] };

    socket.onAny((name: string, payload: Record<string, unknown>) => {
      client.frames.push({ name, payload });
    });

    clients.push(client);

    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => {
        resolve();
      });
      socket.once('connect_error', reject);
    });

    return client;
  };

  const join = async (client: Client, event: unknown): Promise<void> => {
    client.socket.emit('join', event);
    await sleep(SETTLE_MS);
  };

  const framesOf = (client: Client, name: string): Frame[] =>
    client.frames.filter((frame) => frame.name === name);

  const waitForFrame = async (
    client: Client,
    name: string,
    what: string,
  ): Promise<Frame> => {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const found = framesOf(client, name)[0];

      if (found !== undefined) {
        return found;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    throw new Error(
      `${what}: no ${name} frame arrived within ${String(WAIT_TIMEOUT_MS)}ms. ` +
        `Frames seen: ${JSON.stringify(client.frames.map((f) => f.name))}.`,
    );
  };

  const seedSold = async (event: number, seatIds: number[]): Promise<void> => {
    if (seatIds.length > 0) {
      await redis.sadd(soldKey(event), ...seatIds.map(String));
    }

    await redis.set(soldWarmKey(event), '', 'EX', 60);
  };

  const hold = (event: number, seatIds: number[], sessionId: string) =>
    request(http())
      .post('/holds')
      .send({ event_id: event, seat_ids: seatIds, session_id: sessionId })
      .expect(201);

  const release = (event: number, seatIds: number[], sessionId: string) =>
    request(http())
      .delete('/holds')
      .send({ event_id: event, seat_ids: seatIds, session_id: sessionId })
      .expect(204);

  const liveSeats = async (
    event: number,
  ): Promise<{ held: number[]; sold: number[] }> => {
    const response = await request(http())
      .get(`/events/${String(event)}/live-seats`)
      .expect(200);

    return response.body as { held: number[]; sold: number[] };
  };

  const orderPaid = (
    event: number,
    seatIds: number[],
  ): Record<string, unknown> => {
    const id = randomUUID();

    publishedIds.push(id);

    return {
      event_id: id,
      event_type: 'order.paid',
      occurred_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      version: 1,
      payload: {
        order_id: randomUUID(),
        event_id: event,
        seat_ids: seatIds,
        buyer_id: 4,
      },
    };
  };

  const publish = (envelope: Record<string, unknown>): void => {
    channel.publish(
      topology.exchange,
      'order.paid',
      Buffer.from(JSON.stringify(envelope)),
      {
        contentType: 'application/json',
        deliveryMode: 2,
        messageId: envelope.event_id as string,
      },
    );
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CONSUMER_TOPOLOGY)
      .useValue(topology)
      .compile();

    app = moduleRef.createNestApplication<App>();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0);

    const server = app.getHttpServer() as unknown as Server;
    const address = server.address() as AddressInfo;

    url = `http://127.0.0.1:${String(address.port)}`;

    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
    });

    model = await connect(process.env.RABBITMQ_URL as string);
    model.on('error', () => undefined);
    channel = await model.createChannel();
    channel.on('error', () => undefined);

    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    let declared = false;

    while (Date.now() < deadline && !declared) {
      const probe = await model.createChannel();

      probe.on('error', () => undefined);
      declared = await probe
        .checkQueue(topology.queue)
        .then(() => true)
        .catch(() => false);
      await probe.close().catch(() => undefined);

      if (!declared) {
        await sleep(POLL_INTERVAL_MS);
      }
    }

    if (!declared) {
      throw new Error(
        `the consumer never declared ${topology.queue}; the seat.sold test ` +
          'would pass vacuously because nothing would ever be delivered.',
      );
    }
  });

  beforeEach(() => {
    eventId = ++nextEventId;
    otherEventId = ++nextEventId;
    mine = randomUUID();
    theirs = randomUUID();
  });

  afterEach(async () => {
    for (const client of clients) {
      client.socket.disconnect();
    }

    clients.length = 0;

    const keys = [
      ...(await redis.keys(`hold:${String(eventId)}:*`)),
      ...(await redis.keys(`hold:${String(otherEventId)}:*`)),
      ...(await redis.keys(`expiry:*:${String(eventId)}:*`)),
      ...(await redis.keys(`expiry:*:${String(otherEventId)}:*`)),
    ];

    await redis.del(
      ...keys,
      sessionKey(mine),
      sessionKey(theirs),
      soldKey(eventId),
      soldKey(otherEventId),
      soldWarmKey(eventId),
      soldWarmKey(otherEventId),
      ...publishedIds.map((id) => `consumed:${id}`),
    );

    publishedIds.length = 0;
  });

  afterAll(async () => {
    await channel.close().catch(() => undefined);
    await model.close().catch(() => undefined);
    await redis.quit();
    await app.close();
    await deleteTopology(topology);
  });

  describe('snapshot on join', () => {
    it('sends held and sold matching live-seats and the raw Redis state', async () => {
      await seedSold(eventId, [5, 9]);
      await hold(eventId, [3, 7], mine);

      const client = await connectClient();
      await join(client, { event_id: eventId });

      const snapshot = await waitForFrame(
        client,
        'snapshot',
        'a valid join was sent',
      );

      const route = await liveSeats(eventId);
      const rawHeld = (await redis.keys(`hold:${String(eventId)}:*`))
        .map((key) => Number(key.split(':')[2]))
        .sort((a, b) => a - b);
      const rawSold = (await redis.smembers(soldKey(eventId)))
        .map(Number)
        .sort((a, b) => a - b);

      expect(snapshot.payload).toEqual({
        event_id: eventId,
        held: [3, 7],
        sold: [5, 9],
      });
      expect(snapshot.payload.held).toEqual(route.held);
      expect(snapshot.payload.sold).toEqual(route.sold);
      expect(rawHeld).toEqual([3, 7]);
      expect(rawSold).toEqual([5, 9]);
    });

    it('sends two empty arrays for an event with nothing held or sold', async () => {
      await seedSold(eventId, []);

      const client = await connectClient();
      await join(client, { event_id: eventId });

      const snapshot = await waitForFrame(client, 'snapshot', 'an empty event');

      expect(snapshot.payload).toEqual({
        event_id: eventId,
        held: [],
        sold: [],
      });
    });

    it('sends the snapshot to the joining socket only', async () => {
      await seedSold(eventId, []);

      const first = await connectClient();
      await join(first, { event_id: eventId });
      await waitForFrame(first, 'snapshot', 'the first client joined');

      const second = await connectClient();
      await join(second, { event_id: eventId });
      await waitForFrame(second, 'snapshot', 'the second client joined');

      expect(framesOf(first, 'snapshot')).toHaveLength(1);
      expect(framesOf(second, 'snapshot')).toHaveLength(1);
    });

    it('sends a fresh snapshot on a repeat join, which reconnect depends on', async () => {
      await seedSold(eventId, []);

      const client = await connectClient();
      await join(client, { event_id: eventId });
      await waitForFrame(client, 'snapshot', 'the first join');

      await hold(eventId, [4], mine);
      await join(client, { event_id: eventId });

      const snapshots = framesOf(client, 'snapshot');

      expect(snapshots).toHaveLength(2);
      expect(snapshots[1].payload).toEqual({
        event_id: eventId,
        held: [4],
        sold: [],
      });
    });

    it('lets one socket join several events and routes deltas by payload', async () => {
      await seedSold(eventId, []);
      await seedSold(otherEventId, []);

      const client = await connectClient();
      await join(client, { event_id: eventId });
      await join(client, { event_id: otherEventId });

      expect(framesOf(client, 'snapshot')).toHaveLength(2);

      await hold(eventId, [1], mine);
      await hold(otherEventId, [2], mine);
      await sleep(SETTLE_MS);

      expect(
        framesOf(client, 'seat.held').map((frame) => frame.payload),
      ).toEqual([
        { event_id: eventId, seat_ids: [1], session_id: mine },
        { event_id: otherEventId, seat_ids: [2], session_id: mine },
      ]);
    });
  });

  describe('seat.held', () => {
    it('reaches every socket in the room with the holder session id', async () => {
      await seedSold(eventId, []);

      const first = await connectClient();
      const second = await connectClient();
      await join(first, { event_id: eventId });
      await join(second, { event_id: eventId });

      await hold(eventId, [3, 7], theirs);
      await sleep(SETTLE_MS);

      const expected = {
        event_id: eventId,
        seat_ids: [3, 7],
        session_id: theirs,
      };

      expect(framesOf(first, 'seat.held').map((f) => f.payload)).toEqual([
        expected,
      ]);
      expect(framesOf(second, 'seat.held').map((f) => f.payload)).toEqual([
        expected,
      ]);
    });

    it('carries the seats of that request, not the session hold set', async () => {
      await seedSold(eventId, []);
      await hold(eventId, [9], theirs);
      await hold(eventId, [1, 2], mine);

      const client = await connectClient();
      await join(client, { event_id: eventId });

      await hold(eventId, [1, 2, 3], mine);
      await sleep(SETTLE_MS);

      expect(framesOf(client, 'seat.held').map((f) => f.payload)).toEqual([
        { event_id: eventId, seat_ids: [1, 2, 3], session_id: mine },
      ]);
      expect((await liveSeats(eventId)).held).toEqual([1, 2, 3, 9]);
    });

    it('carries only the requesting session seats when another session holds more', async () => {
      await seedSold(eventId, []);
      await hold(eventId, [9], theirs);

      const client = await connectClient();
      await join(client, { event_id: eventId });
      client.frames.length = 0;

      await hold(eventId, [1], mine);
      await sleep(SETTLE_MS);

      expect(framesOf(client, 'seat.held').map((f) => f.payload)).toEqual([
        { event_id: eventId, seat_ids: [1], session_id: mine },
      ]);
    });

    it('sends event_id as a JSON number, never a string', async () => {
      await seedSold(eventId, []);

      const client = await connectClient();
      await join(client, { event_id: eventId });
      await hold(eventId, [1], mine);
      await sleep(SETTLE_MS);

      const frame = await waitForFrame(client, 'seat.held', 'a hold was taken');

      expect(typeof frame.payload.event_id).toBe('number');
      expect(typeof (frame.payload.seat_ids as number[])[0]).toBe('number');
    });
  });

  describe('room isolation', () => {
    it('never shows a client in one event room another event traffic', async () => {
      await seedSold(eventId, []);
      await seedSold(otherEventId, []);

      const here = await connectClient();
      const there = await connectClient();
      await join(here, { event_id: eventId });
      await join(there, { event_id: otherEventId });

      here.frames.length = 0;
      there.frames.length = 0;

      await hold(otherEventId, [1, 2], theirs);
      await release(otherEventId, [1], theirs);
      await sleep(SETTLE_MS);

      expect(there.frames.map((frame) => frame.name)).toEqual([
        'seat.held',
        'seat.released',
      ]);
      expect(here.frames).toEqual([]);
    });

    it('keeps a sale in its own room too', async () => {
      await seedSold(eventId, []);
      await seedSold(otherEventId, []);

      const here = await connectClient();
      const there = await connectClient();
      await join(here, { event_id: eventId });
      await join(there, { event_id: otherEventId });

      here.frames.length = 0;
      there.frames.length = 0;

      publish(orderPaid(otherEventId, [8]));

      await waitForFrame(there, 'seat.sold', 'an order.paid was published');
      await sleep(SETTLE_MS);

      expect(here.frames).toEqual([]);
    });
  });

  describe('seat.released', () => {
    it('follows a deliberate release by the owning session', async () => {
      await seedSold(eventId, []);
      await hold(eventId, [3, 7], mine);

      const client = await connectClient();
      await join(client, { event_id: eventId });

      await release(eventId, [3, 7], mine);
      await sleep(SETTLE_MS);

      expect(framesOf(client, 'seat.released').map((f) => f.payload)).toEqual([
        { event_id: eventId, seat_ids: [3, 7] },
      ]);
    });

    it('follows a TTL expiry with the one seat that expired', async () => {
      await seedSold(eventId, []);
      await hold(eventId, [3], mine);

      const client = await connectClient();
      await join(client, { event_id: eventId });

      await redis.pexpire(holdKey(eventId, 3), FORCED_TTL_MS);
      await redis.pexpire(expiryKey(mine, eventId, 3), FORCED_TTL_MS);

      const frame = await waitForFrame(
        client,
        'seat.released',
        'a hold was forced to expire',
      );

      expect(frame.payload).toEqual({ event_id: eventId, seat_ids: [3] });
    });

    it('says nothing when a foreign session releases seats it does not hold', async () => {
      await seedSold(eventId, []);
      await hold(eventId, [3, 7], mine);

      const client = await connectClient();
      await join(client, { event_id: eventId });
      client.frames.length = 0;

      await release(eventId, [3, 7], theirs);
      await sleep(SETTLE_MS);

      expect(client.frames).toEqual([]);
      expect((await liveSeats(eventId)).held).toEqual([3, 7]);
    });

    it('says nothing when the released seats were already gone', async () => {
      await seedSold(eventId, []);

      const client = await connectClient();
      await join(client, { event_id: eventId });
      client.frames.length = 0;

      await release(eventId, [3], mine);
      await sleep(SETTLE_MS);

      expect(client.frames).toEqual([]);
    });
  });

  describe('seat.sold', () => {
    it('follows an order.paid consumed from RabbitMQ', async () => {
      await seedSold(eventId, []);
      await hold(eventId, [3, 7], mine);

      const client = await connectClient();
      await join(client, { event_id: eventId });

      publish(orderPaid(eventId, [3, 7]));

      const frame = await waitForFrame(
        client,
        'seat.sold',
        'an order.paid was published',
      );

      expect(frame.payload).toEqual({ event_id: eventId, seat_ids: [3, 7] });
      expect(Object.keys(frame.payload).sort()).toEqual([
        'event_id',
        'seat_ids',
      ]);
    });

    it('drops order_id and buyer_id, so no client learns who bought a seat', async () => {
      await seedSold(eventId, []);

      const client = await connectClient();
      await join(client, { event_id: eventId });

      publish(orderPaid(eventId, [4]));

      const frame = await waitForFrame(client, 'seat.sold', 'a sale');

      expect(frame.payload).not.toHaveProperty('order_id');
      expect(frame.payload).not.toHaveProperty('buyer_id');
      expect(JSON.stringify(frame.payload)).not.toContain('buyer');
    });

    it('sends no frame for an order.paid carrying no seats', async () => {
      await seedSold(eventId, []);

      const client = await connectClient();
      await join(client, { event_id: eventId });
      client.frames.length = 0;

      const envelope = orderPaid(eventId, []);

      publish(envelope);

      const deadline = Date.now() + WAIT_TIMEOUT_MS;

      while (Date.now() < deadline) {
        if (
          (await redis.exists(`consumed:${String(envelope.event_id)}`)) === 1
        ) {
          break;
        }

        await sleep(POLL_INTERVAL_MS);
      }

      await sleep(SETTLE_MS);

      expect(client.frames).toEqual([]);
    });
  });

  describe('a failed acquisition', () => {
    it('broadcasts nothing when every seat is already held elsewhere', async () => {
      await seedSold(eventId, []);
      await hold(eventId, [3, 7], theirs);

      const client = await connectClient();
      await join(client, { event_id: eventId });
      client.frames.length = 0;

      await request(http())
        .post('/holds')
        .send({ event_id: eventId, seat_ids: [3, 7], session_id: mine })
        .expect(409);

      await sleep(SETTLE_MS);

      expect(client.frames).toEqual([]);
    });

    it('broadcasts nothing on a partial conflict, whose free seats were rolled back', async () => {
      await seedSold(eventId, []);
      await hold(eventId, [3], theirs);

      const client = await connectClient();
      await join(client, { event_id: eventId });
      client.frames.length = 0;

      const response = await request(http())
        .post('/holds')
        .send({ event_id: eventId, seat_ids: [3, 11], session_id: mine })
        .expect(409);

      await sleep(SETTLE_MS);

      expect(client.frames).toEqual([]);
      expect(
        (
          response.body as {
            error: { details: { conflicting_seat_ids: number[] } };
          }
        ).error.details.conflicting_seat_ids,
      ).toEqual([3]);
      expect((await liveSeats(eventId)).held).toEqual([3]);
    });

    it('still broadcasts the hold that succeeds afterwards', async () => {
      await seedSold(eventId, []);
      await hold(eventId, [3], theirs);

      const client = await connectClient();
      await join(client, { event_id: eventId });
      client.frames.length = 0;

      await request(http())
        .post('/holds')
        .send({ event_id: eventId, seat_ids: [3], session_id: mine })
        .expect(409);
      await hold(eventId, [11], mine);
      await sleep(SETTLE_MS);

      expect(client.frames.map((frame) => frame.name)).toEqual(['seat.held']);
    });
  });

  describe('a malformed join', () => {
    it('joins no room, emits nothing, and leaves the socket connected', async () => {
      await seedSold(eventId, []);

      const client = await connectClient();
      await join(client, { seat_id: eventId });

      expect(client.frames).toEqual([]);
      expect(client.socket.connected).toBe(true);

      await hold(eventId, [3], mine);
      await sleep(SETTLE_MS);

      expect(client.frames).toEqual([]);
    });

    it('refuses a string event_id rather than coercing it into a room', async () => {
      await seedSold(eventId, []);

      const client = await connectClient();
      await join(client, { event_id: String(eventId) });

      expect(client.frames).toEqual([]);

      await hold(eventId, [3], mine);
      await sleep(SETTLE_MS);

      expect(client.frames).toEqual([]);
      expect(client.socket.connected).toBe(true);
    });
  });

  describe('an unavailable sold state', () => {
    it('sends no snapshot and no error, and still joins the room', async () => {
      const client = await connectClient();
      await join(client, { event_id: eventId });

      expect(client.frames).toEqual([]);
      expect(client.socket.connected).toBe(true);

      await hold(eventId, [3], mine);
      await sleep(SETTLE_MS);

      expect(framesOf(client, 'seat.held').map((f) => f.payload)).toEqual([
        { event_id: eventId, seat_ids: [3], session_id: mine },
      ]);
    });
  });

  describe('the shape of the wire', () => {
    it('carries session_id on seat.held and on nothing else', async () => {
      await seedSold(eventId, [9]);
      await hold(eventId, [3, 7], mine);

      const client = await connectClient();
      await join(client, { event_id: eventId });

      await release(eventId, [7], mine);
      publish(orderPaid(eventId, [3]));

      await waitForFrame(client, 'seat.sold', 'a sale');
      await sleep(SETTLE_MS);

      for (const frame of client.frames) {
        if (frame.name === 'seat.held') {
          expect(frame.payload).toHaveProperty('session_id');
        } else {
          expect(frame.payload).not.toHaveProperty('session_id');
        }
      }

      expect(framesOf(client, 'seat.released')).toHaveLength(1);
      expect(framesOf(client, 'seat.sold')).toHaveLength(1);
    });

    it('never puts a fifth event name on the wire', async () => {
      await seedSold(eventId, []);

      const client = await connectClient();
      await join(client, { event_id: eventId });
      await join(client, { event_id: 0 });

      await hold(eventId, [3], mine);
      await release(eventId, [3], mine);
      publish(orderPaid(eventId, [4]));

      await waitForFrame(client, 'seat.sold', 'a sale');
      await sleep(SETTLE_MS);

      expect(
        [...new Set(client.frames.map((frame) => frame.name))].sort(),
      ).toEqual(['seat.held', 'seat.released', 'seat.sold', 'snapshot']);
    });
  });
});
