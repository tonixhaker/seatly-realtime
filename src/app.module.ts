import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ConsumerModule } from './consumer/consumer.module';
import { validateEnv } from './env.schema';
import { ExpiryModule } from './expiry/expiry.module';
import { HealthModule } from './health/health.module';
import { HoldsModule } from './holds/holds.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    HealthModule,
    HoldsModule,
    ExpiryModule,
    ConsumerModule,
  ],
})
export class AppModule {}
