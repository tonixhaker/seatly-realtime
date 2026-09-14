import { Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';

const VALID_ENV = {
  PORT: '3000',
  INTERNAL_TOKEN: 'local-internal-token',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  RABBITMQ_URL: 'amqp://seatly:seatly@127.0.0.1:5672',
};

const startAppModule = async (): Promise<string> => {
  jest.resetModules();
  const { AppModule } = jest.requireActual<{ AppModule: Type }>('./app.module');

  try {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.close();
    return 'started without complaining';
  } catch (error) {
    return error instanceof Error ? error.message : 'unknown failure';
  }
};

describe('AppModule environment validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, ...VALID_ENV };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('refuses to start with a malformed REDIS_PORT, naming the variable', async () => {
    process.env.REDIS_PORT = 'not-a-port';

    await expect(startAppModule()).resolves.toContain('REDIS_PORT');
  });

  it('refuses to start with an out-of-range REDIS_PORT, naming the variable', async () => {
    process.env.REDIS_PORT = '70000';

    await expect(startAppModule()).resolves.toContain('REDIS_PORT');
  });

  it('refuses to start with an empty INTERNAL_TOKEN, naming the variable', async () => {
    process.env.INTERNAL_TOKEN = '';

    await expect(startAppModule()).resolves.toContain('INTERNAL_TOKEN');
  });

  it('refuses to start with an empty RABBITMQ_URL, naming the variable', async () => {
    process.env.RABBITMQ_URL = '';

    await expect(startAppModule()).resolves.toContain('RABBITMQ_URL');
  });

  it('refuses to start with an empty REDIS_HOST, naming validation as the reason', async () => {
    process.env.REDIS_HOST = '';

    await expect(startAppModule()).resolves.toContain(
      'Environment validation failed',
    );
  });
});
