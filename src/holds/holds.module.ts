import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { SoldModule } from '../sold/sold.module';
import { HoldsController } from './holds.controller';
import { HoldsService } from './holds.service';
import { HoldStoreService } from './hold-store.service';

@Module({
  imports: [RedisModule, SoldModule],
  controllers: [HoldsController],
  providers: [HoldsService, HoldStoreService],
  exports: [HoldStoreService],
})
export class HoldsModule {}
