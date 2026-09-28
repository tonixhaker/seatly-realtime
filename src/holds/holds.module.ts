import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SeatEventsModule } from '../events/seat-events.module';
import { RedisModule } from '../redis/redis.module';
import { SoldModule } from '../sold/sold.module';
import { HoldsController } from './holds.controller';
import { HoldsService } from './holds.service';
import { HoldStoreService } from './hold-store.service';

@Module({
  imports: [RedisModule, SoldModule, AuthModule, SeatEventsModule],
  controllers: [HoldsController],
  providers: [HoldsService, HoldStoreService],
  exports: [HoldStoreService, HoldsService],
})
export class HoldsModule {}
