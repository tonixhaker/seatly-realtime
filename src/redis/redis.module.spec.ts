import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import { AddressInfo, createServer, Server, Socket } from 'node:net';
import { RedisModule } from './redis.module';

describe('RedisModule client', () => {
  let server: Server;
  let sockets: Socket[];
  let moduleRef: TestingModule;
  let redis: Redis;

  beforeEach(async () => {
    jest.clearAllMocks();
    sockets = [];
    server = createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ REDIS_HOST: '127.0.0.1', REDIS_PORT: port })],
        }),
        RedisModule,
      ],
    }).compile();

    redis = moduleRef.get(Redis);
  });

  afterEach(async () => {
    const ended = new Promise<void>((resolve) => {
      redis.once('end', () => {
        resolve();
      });
    });
    await moduleRef.close();
    await ended;

    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it('gives up on a command a silent Redis never answers instead of hanging the request', async () => {
    const started = Date.now();

    await expect(redis.get('hold:1:1')).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 15_000);
});
