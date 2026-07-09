import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { AuthenticatedRequest } from './core-auth.guard';

export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): number | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().userId,
);
