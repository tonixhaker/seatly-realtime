import { randomUUID } from 'node:crypto';
import { createConnection, createServer, Server } from 'node:net';
import Redis from 'ioredis';
import {
  EXPIRY_CONNECTION_NAME,
  ExpiryService,
} from '../src/expiry/expiry.service';
import { SeatEventsService } from '../src/events/seat-events.service';
import { HoldStoreService } from '../src/holds/hold-store.service';
import {
  expiryKey,
  holdKey,
  sessionKey,
  sessionMember,
} from '../src/redis/keys';

const BASE_EVENT_ID = 600000 + Math.floor(Math.random() * 90000);
const WAIT_TIMEOUT_MS = 2000;
const POLL_INTERVAL_MS = 25;
const FORCED_TTL_MS = 100;

describe('hold expiry through keyspace notifications', () => {
  let redis: Redis;
  let store: HoldStoreService;
  let expiry: ExpiryService | undefined;
  let eventId: number;
  let otherEventId: number;
  let mine: string;
  let theirs: string;
  let nextEventId = BASE_EVENT_ID;

  beforeAll(async () => {
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
    });

    const config = (await redis.config(
      'GET',
      'notify-keyspace-events',
    )) as string[];
    const flags = config[1] ?? '';

    if (!flags.includes('E') || !flags.includes('x')) {
      throw new Error(
        `notify-keyspace-events is "${flags}"; expiry events require both E and x. ` +
          'No expiry notification will ever be emitted and every assertion in this ' +
          'file would pass vacuously. Start Redis with --notify-keyspace-events Ex.',
      );
    }

    store = new HoldStoreService(redis);
    expiry = new ExpiryService(redis, store, new SeatEventsService());
    await waitUntil(
      async () =>
        (await redis.pubsub('NUMSUB', '__keyevent@0__:expired'))[1] !== 0,
      'the subscriber never registered on __keyevent@0__:expired',
    );
  });

  beforeEach(() => {
    eventId = ++nextEventId;
    otherEventId = ++nextEventId;
    mine = randomUUID();
    theirs = randomUUID();
  });

  afterEach(async () => {
    if (expiry === undefined) {
      return;
    }

    const keys = [
      ...(await redis.keys(`hold:${eventId}:*`)),
      ...(await redis.keys(`hold:${otherEventId}:*`)),
      ...(await redis.keys(`expiry:*:${eventId}:*`)),
      ...(await redis.keys(`expiry:*:${otherEventId}:*`)),
    ];
    await redis.del(...keys, sessionKey(mine), sessionKey(theirs));
  });

  afterAll(async () => {
    expiry?.onModuleDestroy();
    await redis.quit();
  });

  async function waitUntil(
    condition: () => Promise<boolean>,
    failure: string,
  ): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (await condition()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`${failure} within ${String(WAIT_TIMEOUT_MS)}ms.`);
  }

  const forceExpiry = async (
    sessionId: string,
    event: number,
    seatId: number,
  ): Promise<void> => {
    await redis.pexpire(holdKey(event, seatId), FORCED_TTL_MS);
    await redis.pexpire(expiryKey(sessionId, event, seatId), FORCED_TTL_MS);
  };

  const membersOf = async (sessionId: string): Promise<string[]> =>
    (await redis.smembers(sessionKey(sessionId))).sort();

  const waitForMemberToGo = async (
    sessionId: string,
    member: string,
  ): Promise<void> =>
    waitUntil(
      async () => !(await membersOf(sessionId)).includes(member),
      `expected "${member}" to leave ${sessionKey(sessionId)}; it is still there. ` +
        'Either the subscriber is not connected or notify-keyspace-events is not emitting x',
    );

  it('removes the expired seat from its session set', async () => {
    await store.acquire({ eventId, seatIds: [1, 2], sessionId: mine });

    await forceExpiry(mine, eventId, 1);
    await waitForMemberToGo(mine, sessionMember(eventId, 1));

    expect(await redis.exists(holdKey(eventId, 1))).toBe(0);
  });

  it('leaves the session its other seats when one expires', async () => {
    await store.acquire({ eventId, seatIds: [1, 2, 3], sessionId: mine });

    await forceExpiry(mine, eventId, 2);
    await waitForMemberToGo(mine, sessionMember(eventId, 2));

    expect(await membersOf(mine)).toEqual(
      [1, 3].map((seatId) => sessionMember(eventId, seatId)),
    );
  });

  it('removes the seat at the event that expired, not the same seat at another', async () => {
    await store.acquire({ eventId, seatIds: [7], sessionId: mine });
    await store.acquire({
      eventId: otherEventId,
      seatIds: [7],
      sessionId: mine,
    });

    expect(await membersOf(mine)).toEqual(
      [sessionMember(eventId, 7), sessionMember(otherEventId, 7)].sort(),
    );

    await forceExpiry(mine, eventId, 7);
    await waitForMemberToGo(mine, sessionMember(eventId, 7));

    expect(await membersOf(mine)).toEqual([sessionMember(otherEventId, 7)]);
  });

  it('does not touch another session set when a seat expires', async () => {
    await store.acquire({ eventId, seatIds: [1], sessionId: mine });
    await store.acquire({ eventId, seatIds: [2], sessionId: theirs });

    await forceExpiry(mine, eventId, 1);
    await waitForMemberToGo(mine, sessionMember(eventId, 1));

    expect(await membersOf(theirs)).toEqual([sessionMember(eventId, 2)]);
  });

  it('acquires a hold normally while the subscriber is running', async () => {
    expect(
      (await redis.pubsub('NUMSUB', '__keyevent@0__:expired'))[1],
    ).toBeGreaterThan(0);

    const outcome = await store.acquire({
      eventId,
      seatIds: [4, 5],
      sessionId: mine,
    });

    expect(outcome).toEqual({ ok: true, acquired: [4, 5], retained: [] });
    expect(await redis.exists(holdKey(eventId, 4))).toBe(1);
    expect(await membersOf(mine)).toEqual(
      [4, 5].map((seatId) => sessionMember(eventId, seatId)),
    );
  });

  it('releases successfully when the session set names an expired hold', async () => {
    await store.acquire({ eventId, seatIds: [1, 2], sessionId: mine });

    await forceExpiry(mine, eventId, 1);
    await waitForMemberToGo(mine, sessionMember(eventId, 1));

    expect(
      await store.release({ eventId, seatIds: [1, 2], sessionId: mine }),
    ).toEqual([2]);
    expect(await redis.exists(sessionKey(mine))).toBe(0);
  });

  it('leaves no companion key behind after a release', async () => {
    await store.acquire({ eventId, seatIds: [1, 2], sessionId: mine });
    await store.release({ eventId, seatIds: [1, 2], sessionId: mine });

    expect(await redis.keys(`expiry:*:${eventId}:*`)).toEqual([]);
  });

  it('keeps cleaning up after the subscriber connection is dropped', async () => {
    const list = await redis.client('LIST');
    const own = String(list)
      .split('\n')
      .find((line) => line.includes(`name=${EXPIRY_CONNECTION_NAME}`));
    const id = /\bid=(\d+)/.exec(own ?? '')?.[1];

    expect(id).toBeDefined();
    await redis.client('KILL', 'ID', String(id));
    await waitUntil(
      async () =>
        (await redis.pubsub('NUMSUB', '__keyevent@0__:expired'))[1] !== 0,
      'the subscriber never re-registered after its connection was killed',
    );

    await store.acquire({ eventId, seatIds: [9], sessionId: mine });
    await forceExpiry(mine, eventId, 9);
    await waitForMemberToGo(mine, sessionMember(eventId, 9));

    expect(await redis.exists(sessionKey(mine))).toBe(0);
  });

  it('subscribes once Redis becomes reachable after an unreachable start', async () => {
    const host = process.env.REDIS_HOST ?? '127.0.0.1';
    const port = Number(process.env.REDIS_PORT);
    const idle = createServer();
    await new Promise<void>((resolve) => idle.listen(0, '127.0.0.1', resolve));
    const proxyPort = (idle.address() as { port: number }).port;
    await new Promise<void>((resolve) => idle.close(() => resolve()));

    const detached = new Redis({
      host: '127.0.0.1',
      port: proxyPort,
      commandTimeout: 1000,
      maxRetriesPerRequest: 1,
    });
    detached.on('error', () => undefined);
    const detachedStore = new HoldStoreService(redis);
    const cleaned = jest.spyOn(detachedStore, 'forgetExpired');
    const service = new ExpiryService(
      detached,
      detachedStore,
      new SeatEventsService(),
    );
    let proxy: Server | undefined;

    try {
      await store.acquire({ eventId, seatIds: [11], sessionId: theirs });
      await forceExpiry(theirs, eventId, 11);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(cleaned).not.toHaveBeenCalled();

      proxy = createServer((incoming) => {
        const upstream = createConnection({ host, port });
        incoming.pipe(upstream);
        upstream.pipe(incoming);
        upstream.on('error', () => incoming.destroy());
        incoming.on('error', () => upstream.destroy());
      });
      await new Promise<void>((resolve) => {
        proxy?.listen(proxyPort, '127.0.0.1', resolve);
      });

      await store.acquire({ eventId, seatIds: [12], sessionId: theirs });
      await forceExpiry(theirs, eventId, 12);
      await waitUntil(
        async () =>
          Promise.resolve(
            cleaned.mock.calls.some(
              ([call]) => call.eventId === eventId && call.seatId === 12,
            ),
          ),
        'the subscriber never received an expiry after Redis became reachable',
      );
    } finally {
      cleaned.mockRestore();
      service.onModuleDestroy();
      detached.disconnect();
      await new Promise<void>((resolve) => {
        if (proxy === undefined) {
          resolve();
          return;
        }
        proxy.close(() => resolve());
      });
    }
  }, 30_000);
});
