import { Module } from '@nestjs/common';
import { HoldsModule } from './holds/holds.module';

@Module({
  imports: [HoldsModule],
})
export class AppModule {}
