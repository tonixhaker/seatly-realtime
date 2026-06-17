import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema';
import { HealthModule } from './health/health.module';
import { HoldsModule } from './holds/holds.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    HealthModule,
    HoldsModule,
  ],
})
export class AppModule {}
