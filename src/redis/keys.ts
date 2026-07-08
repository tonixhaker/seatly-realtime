export const HOLD_TTL_SECONDS = 600;

export const SOLD_WARM_TTL_SECONDS = 60;

export const EXPIRED_CHANNEL = '__keyevent@0__:expired';

export const holdKey = (eventId: number, seatId: number): string =>
  `hold:${eventId}:${seatId}`;

export const sessionKey = (sessionId: string): string => `session:${sessionId}`;

export const soldKey = (eventId: number): string => `sold:${eventId}`;

export const soldWarmKey = (eventId: number): string => `sold-warm:${eventId}`;

export const holdPattern = (eventId: number): string => `hold:${eventId}:*`;

export const sessionMember = (eventId: number, seatId: number): string =>
  `${eventId}:${seatId}`;

export const expiryKey = (
  sessionId: string,
  eventId: number,
  seatId: number,
): string => `expiry:${sessionId}:${eventId}:${seatId}`;

export interface ExpiredHold {
  sessionId: string;
  eventId: number;
  seatId: number;
}

const EXPIRY_KEY_PATTERN = /^expiry:(.+):(\d+):(\d+)$/;

export const parseExpiryKey = (key: string): ExpiredHold | null => {
  const match = EXPIRY_KEY_PATTERN.exec(key);

  if (match === null) {
    return null;
  }

  return {
    sessionId: match[1],
    eventId: Number(match[2]),
    seatId: Number(match[3]),
  };
};

const HOLD_KEY_PATTERN = /^hold:(\d+):(\d+)$/;

export const parseHoldSeatId = (
  key: string,
  eventId: number,
): number | null => {
  const match = HOLD_KEY_PATTERN.exec(key);

  if (match === null || Number(match[1]) !== eventId) {
    return null;
  }

  return Number(match[2]);
};
