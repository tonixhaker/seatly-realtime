import { ConflictException, Injectable } from '@nestjs/common';
import { HoldSeatsDto } from './dto/hold-seats.dto';
import { ValidateHoldsQueryDto } from './dto/validate-holds-query.dto';
import { LiveSeatsDto, ValidateHoldsDto } from './dto/holds-response.dto';

const SOLD_SEAT_IDS = [3, 7, 11];
const HELD_SEAT_IDS = [5, 9];

@Injectable()
export class HoldsService {
  hold(dto: HoldSeatsDto): void {
    const conflicting = dto.seat_ids.filter((id) => SOLD_SEAT_IDS.includes(id));
    if (conflicting.length > 0) {
      throw new ConflictException({
        code: 'SEATS_CONFLICT',
        message: 'Some of the requested seats are already held.',
        details: { conflicting_seat_ids: conflicting },
      });
    }
  }

  release(dto: HoldSeatsDto): void {
    void dto;
  }

  liveSeats(eventId: number): LiveSeatsDto {
    void eventId;
    return { held: [...HELD_SEAT_IDS], sold: [...SOLD_SEAT_IDS] };
  }

  validate(query: ValidateHoldsQueryDto): ValidateHoldsDto {
    const missing = query.seat_ids.filter((id) => SOLD_SEAT_IDS.includes(id));
    return { valid: missing.length === 0, missing };
  }
}
