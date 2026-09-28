import Redis from 'ioredis';
import {
  SOLD_WARM_TTL_SECONDS,
  seatsKey,
  soldWarmKey,
} from '../../src/redis/keys';

export const SEAT_IDS = Array.from({ length: 50 }, (_, i) => i + 1);

export const knownSeats = async (
  redis: Redis,
  eventId: number,
): Promise<void> => {
  await redis
    .multi()
    .sadd(seatsKey(eventId), ...SEAT_IDS)
    .set(soldWarmKey(eventId), '', 'EX', SOLD_WARM_TTL_SECONDS)
    .exec();
};
