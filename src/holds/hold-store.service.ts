import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import {
  ExpiredHold,
  HOLD_TTL_SECONDS,
  expiryKey,
  holdKey,
  sessionKey,
  sessionMember,
} from '../redis/keys';

export interface HoldPayload {
  sessionId: string;
  userId?: number;
  heldAt: string;
}

export interface AcquireInput {
  eventId: number;
  seatIds: number[];
  sessionId: string;
  userId?: number;
}

export type AcquireOutcome =
  | { ok: true; acquired: number[]; retained: number[] }
  | { ok: false; conflicts: number[] };

export interface ReleaseInput {
  eventId: number;
  seatIds: number[];
  sessionId: string;
}

const OWNER_PATTERN = /"sessionId":"([^"]*)"/;

const ACQUIRE_SCRIPT = `
local n = math.floor((#KEYS - 1) / 2)
local sessionKey = KEYS[#KEYS]
local codes = ''
local conflicted = false
for i = 1, n do
  if redis.call('SET', KEYS[i], ARGV[2], 'NX', 'EX', ARGV[3]) then
    redis.call('SET', KEYS[n + i], '', 'EX', ARGV[3])
    codes = codes .. 'T'
  else
    local current = redis.call('GET', KEYS[i])
    if current and string.match(current, '"sessionId":"([^"]*)"') == ARGV[1] then
      codes = codes .. 'R'
    else
      codes = codes .. 'C'
      conflicted = true
    end
  end
end
if conflicted then
  for i = 1, n do
    if string.sub(codes, i, i) == 'T' then
      redis.call('DEL', KEYS[i])
      redis.call('DEL', KEYS[n + i])
    end
  end
  return codes
end
for i = 1, n do
  redis.call('SADD', sessionKey, ARGV[3 + i])
end
if string.find(codes, 'T') then
  redis.call('EXPIRE', sessionKey, ARGV[3])
end
return codes
`;

const RELEASE_SCRIPT = `
local n = math.floor((#KEYS - 1) / 2)
local sessionKey = KEYS[#KEYS]
local codes = ''
for i = 1, n do
  local current = redis.call('GET', KEYS[i])
  redis.call('SREM', sessionKey, ARGV[1 + i])
  redis.call('DEL', KEYS[n + i])
  if current and string.match(current, '"sessionId":"([^"]*)"') == ARGV[1] then
    redis.call('DEL', KEYS[i])
    codes = codes .. 'D'
  else
    codes = codes .. 'K'
  end
end
return codes
`;

@Injectable()
export class HoldStoreService {
  constructor(private readonly redis: Redis) {}

  async acquire(input: AcquireInput): Promise<AcquireOutcome> {
    const { eventId, seatIds, sessionId, userId } = input;
    const payload: HoldPayload = {
      sessionId,
      userId,
      heldAt: new Date().toISOString(),
    };

    const codes = await this.run(ACQUIRE_SCRIPT, eventId, seatIds, sessionId, [
      JSON.stringify(payload),
      String(HOLD_TTL_SECONDS),
      ...seatIds.map((seatId) => sessionMember(eventId, seatId)),
    ]);

    if (codes.includes('C')) {
      return {
        ok: false,
        conflicts: seatIds.filter((_, i) => codes[i] === 'C'),
      };
    }

    return {
      ok: true,
      acquired: seatIds.filter((_, i) => codes[i] === 'T'),
      retained: seatIds.filter((_, i) => codes[i] === 'R'),
    };
  }

  async release(input: ReleaseInput): Promise<number[]> {
    const { eventId, seatIds, sessionId } = input;

    const codes = await this.run(
      RELEASE_SCRIPT,
      eventId,
      seatIds,
      sessionId,
      seatIds.map((seatId) => sessionMember(eventId, seatId)),
    );

    return seatIds.filter((_, i) => codes[i] === 'D');
  }

  async missing(input: ReleaseInput): Promise<number[]> {
    const { eventId, seatIds, sessionId } = input;

    const payloads = await this.redis.mget(
      ...seatIds.map((seatId) => holdKey(eventId, seatId)),
    );

    return seatIds.filter((_, i) => {
      const payload = payloads[i];
      return payload === null || OWNER_PATTERN.exec(payload)?.[1] !== sessionId;
    });
  }

  async forgetExpired(expired: ExpiredHold): Promise<number> {
    return this.redis.srem(
      sessionKey(expired.sessionId),
      sessionMember(expired.eventId, expired.seatId),
    );
  }

  private async run(
    script: string,
    eventId: number,
    seatIds: number[],
    sessionId: string,
    tail: string[],
  ): Promise<string> {
    const keys = [
      ...seatIds.map((seatId) => holdKey(eventId, seatId)),
      ...seatIds.map((seatId) => expiryKey(sessionId, eventId, seatId)),
      sessionKey(sessionId),
    ];

    const codes: unknown = await this.redis.eval(
      script,
      keys.length,
      ...keys,
      sessionId,
      ...tail,
    );

    if (typeof codes !== 'string' || codes.length !== seatIds.length) {
      throw new Error(
        `Hold script returned an unusable result for ${String(seatIds.length)} seats.`,
      );
    }

    return codes;
  }
}
