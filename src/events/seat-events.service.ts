import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export interface SeatsSold {
  eventId: number;
  seatIds: number[];
}

const SOLD = 'seat.sold';

@Injectable()
export class SeatEventsService extends EventEmitter {
  emitSold(eventId: number, seatIds: number[]): void {
    this.emit(SOLD, { eventId, seatIds });
  }

  onSold(listener: (sold: SeatsSold) => void): this {
    return this.on(SOLD, listener);
  }
}
