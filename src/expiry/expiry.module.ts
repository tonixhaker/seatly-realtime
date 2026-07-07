import { Module } from '@nestjs/common';
import { HoldsModule } from '../holds/holds.module';
import { RedisModule } from '../redis/redis.module';
import { ExpiryService } from './expiry.service';

@Module({
  imports: [RedisModule, HoldsModule],
  providers: [ExpiryService],
})
export class ExpiryModule {}
