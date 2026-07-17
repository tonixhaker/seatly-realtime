import { Module } from '@nestjs/common';
import { SeatEventsModule } from '../events/seat-events.module';
import { HoldsModule } from '../holds/holds.module';
import { RedisModule } from '../redis/redis.module';
import { ExpiryService } from './expiry.service';

@Module({
  imports: [RedisModule, HoldsModule, SeatEventsModule],
  providers: [ExpiryService],
})
export class ExpiryModule {}
