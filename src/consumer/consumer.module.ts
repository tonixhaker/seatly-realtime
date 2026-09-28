import { Module } from '@nestjs/common';
import { SeatEventsModule } from '../events/seat-events.module';
import { HoldsModule } from '../holds/holds.module';
import { RedisModule } from '../redis/redis.module';
import { SoldModule } from '../sold/sold.module';
import { ConsumerService } from './consumer.service';
import { RabbitConsumer } from './rabbit-consumer';
import { CONSUMER_TOPOLOGY, DEFAULT_TOPOLOGY } from './topology';

@Module({
  imports: [RedisModule, SoldModule, HoldsModule, SeatEventsModule],
  providers: [
    ConsumerService,
    RabbitConsumer,
    { provide: CONSUMER_TOPOLOGY, useValue: DEFAULT_TOPOLOGY },
  ],
  exports: [ConsumerService],
})
export class ConsumerModule {}
