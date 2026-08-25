import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { z } from 'zod';
import { coreFetch } from '../core-fetch';
import { EnvConfig } from '../env.schema';
import {
  SOLD_WARM_TTL_SECONDS,
  seatsKey,
  soldKey,
  soldWarmKey,
} from '../redis/keys';

const coreSeats = z.array(
  z.object({ id: z.number().int(), status: z.string() }),
);

interface CoreSeatIds {
  all: number[];
  sold: number[];
}

@Injectable()
export class SoldCacheService {
  private readonly warming = new Map<number, Promise<number[]>>();

  constructor(
    private readonly redis: Redis,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  async soldSeats(eventId: number): Promise<number[]> {
    if ((await this.redis.exists(soldWarmKey(eventId))) === 1) {
      return this.cached(eventId);
    }

    const inFlight = this.warming.get(eventId);

    if (inFlight !== undefined) {
      return inFlight;
    }

    const warm = this.warm(eventId).finally(() => this.warming.delete(eventId));

    this.warming.set(eventId, warm);

    return warm;
  }

  async markSold(eventId: number, seatIds: number[]): Promise<void> {
    if (seatIds.length === 0) {
      return;
    }

    await this.redis.sadd(soldKey(eventId), ...seatIds);
  }

  async markPublished(eventId: number, seatIds: number[]): Promise<void> {
    const write = this.redis.multi();

    if (seatIds.length > 0) {
      write.sadd(seatsKey(eventId), ...seatIds);
    }

    write.set(soldWarmKey(eventId), '', 'EX', SOLD_WARM_TTL_SECONDS);
    await write.exec();
  }

  private async warm(eventId: number): Promise<number[]> {
    let seats: CoreSeatIds;

    try {
      seats = await this.fromCore(eventId);
    } catch {
      const stale = await this.cached(eventId);

      if (
        stale.length > 0 ||
        (await this.redis.exists(seatsKey(eventId))) === 1
      ) {
        return stale;
      }

      throw new ServiceUnavailableException({
        code: 'SOLD_STATE_UNAVAILABLE',
        message: 'The sold seats of this event are temporarily unknown.',
      });
    }

    const write = this.redis.multi();

    if (seats.all.length > 0) {
      write.sadd(seatsKey(eventId), ...seats.all);
    }

    if (seats.sold.length > 0) {
      write.sadd(soldKey(eventId), ...seats.sold);
    }

    write.set(soldWarmKey(eventId), '', 'EX', SOLD_WARM_TTL_SECONDS);
    await write.exec();

    return this.cached(eventId);
  }

  private async fromCore(eventId: number): Promise<CoreSeatIds> {
    const base = this.config.get('CORE_API_URL', { infer: true });

    const response = await coreFetch(
      base,
      `/api/v1/events/${String(eventId)}/seats`,
    );

    if (response.status === 404) {
      return { all: [], sold: [] };
    }

    if (!response.ok) {
      throw new Error(
        `Core answered ${String(response.status)} for the seats of event ${String(eventId)}.`,
      );
    }

    const seats = coreSeats.parse(await response.json());

    return {
      all: seats.map((seat) => seat.id),
      sold: seats
        .filter((seat) => seat.status === 'sold')
        .map((seat) => seat.id),
    };
  }

  private async cached(eventId: number): Promise<number[]> {
    const members = await this.redis.smembers(soldKey(eventId));

    return members.map(Number).sort((a, b) => a - b);
  }
}
