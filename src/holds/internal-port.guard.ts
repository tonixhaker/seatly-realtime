import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { EnvConfig } from '../env.schema';

@Injectable()
export class InternalPortGuard implements CanActivate {
  constructor(private readonly config: ConfigService<EnvConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (request.socket.localPort !== this.config.get('INTERNAL_PORT')) {
      throw new NotFoundException();
    }
    return true;
  }
}
