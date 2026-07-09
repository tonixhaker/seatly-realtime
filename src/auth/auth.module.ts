import { Module } from '@nestjs/common';
import { TokenAuthService } from './token-auth.service';

@Module({
  providers: [TokenAuthService],
  exports: [TokenAuthService],
})
export class AuthModule {}
