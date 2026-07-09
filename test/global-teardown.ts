import Redis from 'ioredis';

const SAMPLE_SIZE = 20;

const RANGE_OWNERS =
  'auth 400000-490000, sold-cache 500000-590000, expiry 600000-690000, ' +
  'holds 700000-790000, holds-concurrency 800000-890000, holds-redis 900000-990000';

export default async function failOnLeakedKeys(): Promise<void> {
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
  });

  const leaked = await redis.keys('*');

  await redis.quit();

  if (leaked.length === 0) {
    return;
  }

  throw new Error(
    `${String(leaked.length)} key(s) survived the e2e run, so a spec is missing ` +
      'teardown; every spec must delete its own keys in afterEach. Leaked: ' +
      `${leaked.slice(0, SAMPLE_SIZE).join(', ')}. The event id in a leaked key ` +
      `names the spec that owns it — ${RANGE_OWNERS}.`,
  );
}
