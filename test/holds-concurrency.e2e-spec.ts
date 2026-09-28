import { ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Redis from 'ioredis';
import { seatsKey, sessionMember, soldWarmKey } from '../src/redis/keys';
import { AcquireOutcome } from '../src/holds/hold-store.service';
import { knownSeats } from './support/known-seats';

const ROUNDS = 20;
const SEAT_IDS = [1, 2, 3, 4];
const BASE_EVENT_ID = 800000 + Math.floor(Math.random() * 90000);
const RUN_ID = randomUUID();

interface ResultMessage {
  type: 'result';
  round: number;
  outcome: AcquireOutcome;
}

interface FailureMessage {
  type: 'failure';
  round: number;
  message: string;
}

type ChildMessage = ResultMessage | FailureMessage;

const isForRound = (message: unknown, round: number): message is ChildMessage =>
  typeof message === 'object' &&
  message !== null &&
  ['result', 'failure'].includes((message as ChildMessage).type) &&
  (message as ChildMessage).round === round;

const byValue = (a: number, b: number): number => a - b;

describe('concurrent acquisition of overlapping seat sets', () => {
  let redis: Redis;
  let children: ChildProcess[];
  const exitFailures: string[] = [];

  beforeAll(() => {
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
    });

    children = [0, 1].map(() =>
      fork(join(__dirname, 'support', 'acquire-child.ts'), [], {
        execArgv: ['-r', 'ts-node/register'],
        cwd: join(__dirname, '..'),
        env: { ...process.env },
      }),
    );

    for (const child of children) {
      child.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          exitFailures.push(`acquisition child exited with ${String(code)}`);
        }
      });
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            child.on('exit', () => {
              resolve();
            });
            if (child.connected) {
              child.send({ type: 'stop' });
            } else {
              resolve();
            }
          }),
      ),
    );
    await redis.quit();
  });

  const nextResult = (
    child: ChildProcess,
    round: number,
  ): Promise<AcquireOutcome> =>
    new Promise((resolve, reject) => {
      const onMessage = (message: unknown): void => {
        if (!isForRound(message, round)) {
          return;
        }
        child.off('message', onMessage);
        if (message.type === 'failure') {
          reject(new Error(`round ${String(round)}: ${message.message}`));
          return;
        }
        resolve(message.outcome);
      };
      child.on('message', onMessage);
    });

  const parkedOnBarrier = async (channel: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const reply = (await redis.pubsub('NUMSUB', channel)) as [string, string];
      const parked = Number(reply[1]);
      if (parked === 2) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `only ${String(parked)} of 2 children parked on ${channel}; the two never contended`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  it('resolves every round to exactly one winner', async () => {
    let winners = 0;

    for (let round = 0; round < ROUNDS; round++) {
      const eventId = BASE_EVENT_ID + round;
      const channel = `barrier:${RUN_ID}:${String(round)}`;
      const sessions = [randomUUID(), randomUUID()];
      const seatOrders = [SEAT_IDS, [...SEAT_IDS].reverse()];

      await knownSeats(redis, eventId);

      const results = children.map((child, index) => {
        const settled = nextResult(child, round);
        child.send({
          type: 'round',
          round,
          channel,
          eventId,
          seatIds: seatOrders[index],
          sessionId: sessions[index],
        });
        return settled;
      });

      await parkedOnBarrier(channel);
      await redis.publish(channel, 'go');

      const outcomes = await Promise.all(results);
      const won = outcomes.filter((outcome) => outcome.ok);

      expect(`round ${String(round)}: ${String(won.length)} winners`).toBe(
        `round ${String(round)}: 1 winners`,
      );
      winners += won.length;

      const winnerIndex = outcomes.findIndex((outcome) => outcome.ok);
      const loser = outcomes[1 - winnerIndex];
      expect(loser.ok).toBe(false);
      expect(
        'conflicts' in loser ? [...loser.conflicts].sort(byValue) : loser,
      ).toEqual(SEAT_IDS);

      const heldKeys = await redis.keys(`hold:${String(eventId)}:*`);
      expect(heldKeys).toHaveLength(SEAT_IDS.length);

      const owners = await redis.mget(...heldKeys);
      for (const payload of owners) {
        expect(payload).toContain(sessions[winnerIndex]);
      }

      expect(
        (await redis.smembers(`session:${sessions[winnerIndex]}`)).sort(),
      ).toEqual(
        SEAT_IDS.map((seatId) => sessionMember(eventId, seatId)).sort(),
      );
      expect(await redis.exists(`session:${sessions[1 - winnerIndex]}`)).toBe(
        0,
      );

      const companionKeys = await redis.keys(`expiry:*:${String(eventId)}:*`);
      await redis.del(
        ...heldKeys,
        ...companionKeys,
        `session:${sessions[winnerIndex]}`,
        seatsKey(eventId),
        soldWarmKey(eventId),
      );
    }

    expect(winners).toBe(ROUNDS);
    expect(exitFailures).toEqual([]);
  }, 120_000);
});
