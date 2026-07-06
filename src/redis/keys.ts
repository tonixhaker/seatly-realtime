export const HOLD_TTL_SECONDS = 600;

export const holdKey = (eventId: number, seatId: number): string =>
  `hold:${eventId}:${seatId}`;

export const sessionKey = (sessionId: string): string => `session:${sessionId}`;
