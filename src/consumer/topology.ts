export interface ConsumerTopology {
  exchange: string;
  queue: string;
  deadLetterQueue: string;
}

export const CONSUMER_TOPOLOGY = 'CONSUMER_TOPOLOGY';

export const DEFAULT_TOPOLOGY: ConsumerTopology = {
  exchange: 'seatly.events',
  queue: 'realtime.seatly',
  deadLetterQueue: 'realtime.seatly.dlq',
};

export const MAX_ATTEMPTS = 3;
