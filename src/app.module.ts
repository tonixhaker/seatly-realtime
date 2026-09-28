import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ConsumerModule } from './consumer/consumer.module';
import { validateEnv } from './env.schema';
import { ExpiryModule } from './expiry/expiry.module';
import { GatewayModule } from './gateway/gateway.module';
import { HealthModule } from './health/health.module';
import { HoldsModule } from './holds/holds.module';
import { loggerModule } from './logging';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    loggerModule,
    HealthModule,
    HoldsModule,
    ExpiryModule,
    ConsumerModule,
    GatewayModule,
  ],
})
export class AppModule {}
