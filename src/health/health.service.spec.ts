import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { ChannelModel, connect } from 'amqplib';
import Redis from 'ioredis';
import { HealthService } from './health.service';

const mockRedisClient = {
  ping: jest.fn(),
  on: jest.fn(),
  disconnect: jest.fn(),
};

const mockAmqpConnection = {
  on: jest.fn(),
  close: jest.fn(),
};

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn(() => mockRedisClient),
}));

jest.mock('amqplib', () => ({ connect: jest.fn() }));

const ENV = {
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: 6379,
  RABBITMQ_URL: 'amqp://seatly:seatly@127.0.0.1:5672',
};

const redisConstructor = jest.mocked(Redis);
const amqpConnect = jest.mocked(connect);

describe('HealthService', () => {
  let service: HealthService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRedisClient.ping.mockResolvedValue('PONG');
    mockAmqpConnection.close.mockResolvedValue(undefined);
    amqpConnect.mockResolvedValue(
      mockAmqpConnection as unknown as ChannelModel,
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        {
          provide: ConfigService,
          useValue: { get: (key: keyof typeof ENV) => ENV[key] },
        },
      ],
    }).compile();

    service = module.get(HealthService);
  });

  it('reports ok when both dependencies answer', async () => {
    await expect(service.check()).resolves.toEqual({
      status: 'ok',
      checks: { redis: 'ok', rabbitmq: 'ok' },
    });
  });

  it('reports both checks as failing when neither dependency answers, without throwing', async () => {
    mockRedisClient.ping.mockRejectedValue(new Error('ECONNREFUSED'));
    amqpConnect.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(service.check()).resolves.toEqual({
      status: 'error',
      checks: { redis: 'error', rabbitmq: 'error' },
    });
  });

  it('probes RabbitMQ even when Redis has already failed', async () => {
    mockRedisClient.ping.mockRejectedValue(new Error('ECONNREFUSED'));

    await service.check();

    expect(amqpConnect).toHaveBeenCalledTimes(1);
  });

  it('closes the RabbitMQ connection after every probe', async () => {
    await service.check();
    await service.check();
    await service.check();

    expect(amqpConnect).toHaveBeenCalledTimes(3);
    expect(mockAmqpConnection.close).toHaveBeenCalledTimes(3);
  });

  it('still reports rabbitmq ok when closing the probe connection fails', async () => {
    mockAmqpConnection.close.mockRejectedValue(
      new Error('socket already gone'),
    );

    await expect(service.check()).resolves.toEqual({
      status: 'ok',
      checks: { redis: 'ok', rabbitmq: 'ok' },
    });
  });

  it('reuses a single Redis client across probes instead of connecting per probe', async () => {
    await service.check();
    await service.check();

    expect(redisConstructor).toHaveBeenCalledTimes(1);
    expect(mockRedisClient.ping).toHaveBeenCalledTimes(2);
  });

  it('disconnects the Redis client when the module shuts down', () => {
    service.onModuleDestroy();

    expect(mockRedisClient.disconnect).toHaveBeenCalledTimes(1);
  });
});
