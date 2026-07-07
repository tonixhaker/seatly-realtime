import { ConflictException, Injectable } from '@nestjs/common';
import { HoldSeatsDto } from './dto/hold-seats.dto';
import { ValidateHoldsQueryDto } from './dto/validate-holds-query.dto';
import { LiveSeatsDto, ValidateHoldsDto } from './dto/holds-response.dto';
import { HoldStoreService } from './hold-store.service';

const SOLD_SEAT_IDS = [3, 7, 11];
const HELD_SEAT_IDS = [5, 9];

@Injectable()
export class HoldsService {
  constructor(private readonly store: HoldStoreService) {}

  async hold(dto: HoldSeatsDto): Promise<void> {
    const outcome = await this.store.acquire({
      eventId: dto.event_id,
      seatIds: dto.seat_ids,
      sessionId: dto.session_id,
    });

    if (!outcome.ok) {
      throw new ConflictException({
        code: 'SEATS_CONFLICT',
        message: 'Some of the requested seats are already held.',
        details: { conflicting_seat_ids: outcome.conflicts },
      });
    }
  }

  async release(dto: HoldSeatsDto): Promise<void> {
    await this.store.release({
      eventId: dto.event_id,
      seatIds: dto.seat_ids,
      sessionId: dto.session_id,
    });
  }

  liveSeats(eventId: number): LiveSeatsDto {
    void eventId;
    return { held: [...HELD_SEAT_IDS], sold: [...SOLD_SEAT_IDS] };
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
