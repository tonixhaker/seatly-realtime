import { ConflictException, Injectable } from '@nestjs/common';
import { HoldSeatsDto } from './dto/hold-seats.dto';
import { ValidateHoldsQueryDto } from './dto/validate-holds-query.dto';
import { LiveSeatsDto, ValidateHoldsDto } from './dto/holds-response.dto';
import { SeatEventsService } from '../events/seat-events.service';
import { HoldStoreService } from './hold-store.service';
import { SoldCacheService } from '../sold/sold-cache.service';

@Injectable()
export class HoldsService {
  constructor(
    private readonly store: HoldStoreService,
    private readonly sold: SoldCacheService,
    private readonly seatEvents: SeatEventsService,
  ) {}

  async hold(dto: HoldSeatsDto, userId: number | undefined): Promise<void> {
    const outcome = await this.store.acquire({
      eventId: dto.event_id,
      seatIds: dto.seat_ids,
      sessionId: dto.session_id,
      userId,
    });

    if (!outcome.ok) {
      throw new ConflictException({
        code: 'SEATS_CONFLICT',
        message: 'Some of the requested seats are already held.',
        details: { conflicting_seat_ids: outcome.conflicts },
      });
    }

    this.seatEvents.emitHeld(dto.event_id, dto.seat_ids, dto.session_id);
  }

  async release(dto: HoldSeatsDto): Promise<void> {
    const released = await this.store.release({
      eventId: dto.event_id,
      seatIds: dto.seat_ids,
      sessionId: dto.session_id,
    });

    this.seatEvents.emitReleased(dto.event_id, released);
  }

  async liveSeats(eventId: number): Promise<LiveSeatsDto> {
    const [held, sold] = await Promise.all([
      this.store.heldSeats(eventId),
      this.sold.soldSeats(eventId),
    ]);

    const soldSeats = new Set(sold);

    return { held: held.filter((seatId) => !soldSeats.has(seatId)), sold };
  }

  async validate(query: ValidateHoldsQueryDto): Promise<ValidateHoldsDto> {
    const missing = await this.store.missing({
      eventId: query.event_id,
      seatIds: query.seat_ids,
      sessionId: query.session_id,
    });

    return { valid: missing.length === 0, missing };
  }
}
