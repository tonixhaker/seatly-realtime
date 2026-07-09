import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { coreFetch } from '../core-fetch';
import { EnvConfig } from '../env.schema';

export const AUTH_CACHE_TTL_MS = 60_000;

export const AUTH_CACHE_MAX_ENTRIES = 10000;

const coreUser = z.object({ id: z.number().int() });

interface CacheEntry {
  userId: number | null;
  expiresAt: number;
}

@Injectable()
export class TokenAuthService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly config: ConfigService<EnvConfig, true>) {}

  async userIdFor(token: string): Promise<number> {
    const digest = createHash('sha256').update(token).digest('hex');
    const cached = this.cache.get(digest);

    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return TokenAuthService.identify(cached.userId);
    }

    const userId = await this.fromCore(token);

    if (this.cache.size >= AUTH_CACHE_MAX_ENTRIES) {
      this.cache.clear();
    }

    this.cache.set(digest, {
      userId,
      expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
    });

    return TokenAuthService.identify(userId);
  }

  private async fromCore(token: string): Promise<number | null> {
    const base = this.config.get('CORE_API_URL', { infer: true });
    let response: Response;

    try {
      response = await coreFetch(base, '/api/v1/me', {
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      throw TokenAuthService.unverifiable();
    }

    if (response.status === 401) {
      return null;
    }

    if (!response.ok) {
      throw TokenAuthService.unverifiable();
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch {
      throw TokenAuthService.unverifiable();
    }

    const parsed = coreUser.safeParse(body);

    if (!parsed.success) {
      throw TokenAuthService.unverifiable();
    }

    return parsed.data.id;
  }

  private static identify(userId: number | null): number {
    if (userId === null) {
      throw new UnauthorizedException();
    }

    return userId;
  }

  private static unverifiable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'AUTH_STATE_UNAVAILABLE',
      message: 'Your session could not be verified right now.',
    });
  }
}
