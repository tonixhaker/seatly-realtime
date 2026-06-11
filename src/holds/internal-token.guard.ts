import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';

export const INTERNAL_TOKEN_HEADER = 'X-Internal-Token';

@Injectable()
export class InternalTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.INTERNAL_TOKEN;
    const provided = context
      .switchToHttp()
      .getRequest<Request>()
      .header(INTERNAL_TOKEN_HEADER);

    if (
      expected === undefined ||
      expected === '' ||
      provided === undefined ||
      !InternalTokenGuard.matches(expected, provided)
    ) {
      throw new UnauthorizedException();
    }
    return true;
  }

  private static matches(expected: string, provided: string): boolean {
    return timingSafeEqual(
      createHash('sha256').update(expected).digest(),
      createHash('sha256').update(provided).digest(),
    );
  }
}
