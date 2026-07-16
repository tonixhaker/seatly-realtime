import { Module } from '@nestjs/common';
import { SeatEventsService } from './seat-events.service';

@Module({
  providers: [SeatEventsService],
  exports: [SeatEventsService],
})
export class SeatEventsModule {}
