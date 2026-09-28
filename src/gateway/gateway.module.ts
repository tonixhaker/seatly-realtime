import { Module } from '@nestjs/common';
import { SeatEventsModule } from '../events/seat-events.module';
import { HoldsModule } from '../holds/holds.module';
import { EventsGateway } from './events.gateway';

@Module({
  imports: [HoldsModule, SeatEventsModule],
  providers: [EventsGateway],
})
export class GatewayModule {}
