import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import {
  ExpiredHold,
  HOLD_TTL_SECONDS,
  expiryKey,
  holdKey,
  holdPattern,
  parseHoldSeatId,
  seatsKey,
  sessionKey,
  sessionMember,
  soldKey,
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
  | { ok: false; conflicts: number[] }
  | { ok: false; unknown: number[] };

export interface ReleaseInput {
  eventId: number;
  seatIds: number[];
  sessionId: string;
}

const OWNER_PATTERN = /"sessionId":"([^"]*)"/;

const SCAN_COUNT = 100;

const ACQUIRE_SCRIPT = `
local n = math.floor((#KEYS - 3) / 2)
local soldKey = KEYS[2 * n + 1]
local seatsKey = KEYS[2 * n + 2]
local sessionKey = KEYS[#KEYS]
local verdicts = ''
local refused = false
for i = 1, n do
  local seat = ARGV[3 + n + i]
  if redis.call('SISMEMBER', seatsKey, seat) == 0 then
    verdicts = verdicts .. 'U'
    refused = true
  elseif redis.call('SISMEMBER', soldKey, seat) == 1 then
    verdicts = verdicts .. 'S'
    refused = true
  else
    local current = redis.call('GET', KEYS[i])
    if current and string.match(current, '"sessionId":"([^"]*)"') ~= ARGV[1] then
      verdicts = verdicts .. 'C'
    else
      verdicts = verdicts .. '-'
    end
  end
end
if refused then
  return verdicts
end
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

const FORCE_RELEASE_SCRIPT = `
local codes = ''
for i = 1, #KEYS do
  local current = redis.call('GET', KEYS[i])
  if current then
    local session = string.match(current, '"sessionId":"([^"]*)"')
    redis.call('DEL', KEYS[i])
    if session then
      local member = ARGV[1] .. ':' .. ARGV[1 + i]
      redis.call('DEL', 'expiry:' .. session .. ':' .. member)
      redis.call('SREM', 'session:' .. session, member)
    end
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

    const codes = await this.run(
      ACQUIRE_SCRIPT,
      eventId,
      seatIds,
      sessionId,
      [
        JSON.stringify(payload),
        String(HOLD_TTL_SECONDS),
        ...seatIds.map((seatId) => sessionMember(eventId, seatId)),
        ...seatIds.map(String),
      ],
      [soldKey(eventId), seatsKey(eventId)],
    );

    if (codes.includes('U')) {
      return {
        ok: false,
        unknown: seatIds.filter((_, i) => codes[i] === 'U'),
      };
    }

    if (codes.includes('C') || codes.includes('S')) {
      return {
        ok: false,
        conflicts: seatIds.filter(
          (_, i) => codes[i] === 'C' || codes[i] === 'S',
        ),
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

  async forceRelease(
    input: Omit<ReleaseInput, 'sessionId'>,
  ): Promise<number[]> {
    const { eventId, seatIds } = input;

    if (seatIds.length === 0) {
      return [];
    }

    const keys = seatIds.map((seatId) => holdKey(eventId, seatId));

    const codes = this.decode(
      await this.redis.eval(
        FORCE_RELEASE_SCRIPT,
        keys.length,
        ...keys,
        String(eventId),
        ...seatIds.map(String),
      ),
      seatIds.length,
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

  async heldSeats(eventId: number): Promise<number[]> {
    const pattern = holdPattern(eventId);
    const seatIds = new Set<number>();
    let cursor = '0';

    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        SCAN_COUNT,
      );

      cursor = next;

      for (const key of keys) {
        const seatId = parseHoldSeatId(key, eventId);

        if (seatId !== null) {
          seatIds.add(seatId);
        }
      }
    } while (cursor !== '0');

    return [...seatIds].sort((a, b) => a - b);
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
    middle: string[] = [],
  ): Promise<string> {
    const keys = [
      ...seatIds.map((seatId) => holdKey(eventId, seatId)),
      ...seatIds.map((seatId) => expiryKey(sessionId, eventId, seatId)),
      ...middle,
      sessionKey(sessionId),
    ];

    const codes: unknown = await this.redis.eval(
      script,
      keys.length,
      ...keys,
      sessionId,
      ...tail,
    );

    return this.decode(codes, seatIds.length);
  }

  private decode(codes: unknown, expected: number): string {
    if (typeof codes !== 'string' || codes.length !== expected) {
      throw new Error(
        `Hold script returned an unusable result for ${String(expected)} seats.`,
      );
    }

    return codes;
  }
}
