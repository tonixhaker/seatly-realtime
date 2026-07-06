import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { HoldsController } from './holds.controller';
import { HoldsService } from './holds.service';
import { HoldStoreService } from './hold-store.service';

@Module({
  imports: [RedisModule],
  controllers: [HoldsController],
  providers: [HoldsService, HoldStoreService],
  exports: [HoldStoreService],
})
export class HoldsModule {}
