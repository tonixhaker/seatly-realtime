jest.mock('ioredis', () =>
  jest.requireActual<typeof import('ioredis')>('ioredis-mock'),
);

import flushTestKeyspace from './global-setup';

describe('the loopback guard in global-setup', () => {
  const original = process.env.REDIS_HOST;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.REDIS_HOST;
    } else {
      process.env.REDIS_HOST = original;
    }
  });

  it('refuses to flush a non-loopback host, without ever opening a connection', async () => {
    process.env.REDIS_HOST = 'redis.production.internal';

    await expect(flushTestKeyspace()).rejects.toThrow(/refusing to FLUSHALL/);
  });

  it('flushes a loopback host without throwing', async () => {
    process.env.REDIS_HOST = '127.0.0.1';

    await expect(flushTestKeyspace()).resolves.toBeUndefined();
  });
});
