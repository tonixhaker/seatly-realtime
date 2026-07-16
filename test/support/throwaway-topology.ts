import { randomUUID } from 'node:crypto';
import { connect } from 'amqplib';
import type { ConsumerTopology } from '../../src/consumer/topology';

export const throwawayTopology = (label: string): ConsumerTopology => {
  const id = `${label}.${process.env.JEST_WORKER_ID ?? '0'}.${randomUUID()}`;

  return {
    exchange: `test.${id}`,
    queue: `test.${id}.queue`,
    deadLetterQueue: `test.${id}.queue.dlq`,
  };
};

export const deleteTopology = async (
  topology: ConsumerTopology,
): Promise<void> => {
  const model = await connect(process.env.RABBITMQ_URL as string).catch(
    () => undefined,
  );

  if (model === undefined) {
    return;
  }

  const channel = await model.createChannel();

  await channel.deleteQueue(topology.queue).catch(() => undefined);
  await channel.deleteQueue(topology.deadLetterQueue).catch(() => undefined);
  await channel.deleteExchange(topology.exchange).catch(() => undefined);
  await model.close().catch(() => undefined);
};
