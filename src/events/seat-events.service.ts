import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export interface SeatsHeld {
  eventId: number;
  seatIds: number[];
  sessionId: string;
}

export interface SeatsReleased {
  eventId: number;
  seatIds: number[];
}

export interface SeatsSold {
  eventId: number;
  seatIds: number[];
}

const HELD = 'seat.held';

const RELEASED = 'seat.released';

const SOLD = 'seat.sold';

@Injectable()
export class SeatEventsService extends EventEmitter {
  emitHeld(eventId: number, seatIds: number[], sessionId: string): void {
    this.emit(HELD, { eventId, seatIds, sessionId });
  }

  onHeld(listener: (held: SeatsHeld) => void): this {
    return this.on(HELD, listener);
  }

  emitReleased(eventId: number, seatIds: number[]): void {
    this.emit(RELEASED, { eventId, seatIds });
  }

  onReleased(listener: (released: SeatsReleased) => void): this {
    return this.on(RELEASED, listener);
  }

  emitSold(eventId: number, seatIds: number[]): void {
    this.emit(SOLD, { eventId, seatIds });
  }

  onSold(listener: (sold: SeatsSold) => void): this {
    return this.on(SOLD, listener);
  }
}
