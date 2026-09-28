import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { SoldCacheService } from './sold-cache.service';

@Module({
  imports: [RedisModule],
  providers: [SoldCacheService],
  exports: [SoldCacheService],
})
export class SoldModule {}
