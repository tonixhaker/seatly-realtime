import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { TokenAuthService } from './token-auth.service';

export const BEARER_PATTERN = /^Bearer (\S+)$/;

export interface AuthenticatedRequest extends Request {
  userId?: number;
}

@Injectable()
export class CoreAuthGuard implements CanActivate {
  constructor(private readonly auth: TokenAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.header('Authorization');

    if (header === undefined) {
      return true;
    }

    const bearer = BEARER_PATTERN.exec(header);

    if (bearer === null) {
      throw new UnauthorizedException();
    }

    request.userId = await this.auth.userIdFor(bearer[1]);

    return true;
  }
}
