import Redis from 'ioredis';
import { HoldStoreService } from '../../src/holds/hold-store.service';

interface RoundMessage {
  type: 'round';
  round: number;
  channel: string;
  eventId: number;
  seatIds: number[];
  sessionId: string;
}

interface StopMessage {
  type: 'stop';
}

type ParentMessage = RoundMessage | StopMessage;

const send = (message: unknown): void => {
  process.send?.(message);
};

const main = async (): Promise<void> => {
  const host = process.env.REDIS_HOST;
  const port = Number(process.env.REDIS_PORT);
  const cmd = new Redis({ host, port });
  const sub = new Redis({ host, port });

  try {
    await cmd.ping();
  } catch {
    process.stderr.write(
      `acquire-child cannot reach redis at ${String(host)}:${String(port)}\n`,
    );
    process.exit(2);
  }

  const store = new HoldStoreService(cmd);
  let pending: RoundMessage | undefined;

  sub.on('message', (channel: string) => {
    const round = pending;
    if (round === undefined || round.channel !== channel) {
      return;
    }
    pending = undefined;

    void store
      .acquire({
        eventId: round.eventId,
        seatIds: round.seatIds,
        sessionId: round.sessionId,
      })
      .then(async (outcome) => {
        await sub.unsubscribe(round.channel);
        send({ type: 'result', round: round.round, outcome });
      })
      .catch((error: unknown) => {
        send({
          type: 'failure',
          round: round.round,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  });

  process.on('message', (message: ParentMessage) => {
    if (message.type === 'stop') {
      cmd.disconnect();
      sub.disconnect();
      process.exit(0);
    }

    pending = message;
    void sub.subscribe(message.channel);
  });
};

void main();
