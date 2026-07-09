import Redis from 'ioredis';

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

export default async function flushTestKeyspace(): Promise<void> {
  const host = process.env.REDIS_HOST ?? '127.0.0.1';
  const port = Number(process.env.REDIS_PORT ?? 6379);

  if (!LOOPBACK.includes(host)) {
    throw new Error(
      `refusing to FLUSHALL the Redis at ${host}:${String(port)}: the e2e suite ` +
        'only ever runs against a local throwaway server, and a non-loopback host ' +
        'is far more likely to be a real environment than a test one.',
    );
  }

  const redis = new Redis({ host, port });

  await redis.flushall();
  await redis.quit();
}
