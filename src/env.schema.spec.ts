import { validateEnv } from './env.schema';

const COMPLETE = {
  PORT: '3000',
  INTERNAL_TOKEN: 'local-internal-token',
  REDIS_HOST: 'redis',
  REDIS_PORT: '6379',
  RABBITMQ_URL: 'amqp://seatly:seatly@rabbitmq:5672',
  CORE_API_URL: 'http://api:8000',
  WEB_ORIGIN: 'http://localhost:5173',
};

const without = (key: string): Record<string, unknown> => {
  const config: Record<string, unknown> = { ...COMPLETE };
  delete config[key];
  return config;
};

describe('validateEnv', () => {
  it('accepts a complete environment and coerces the numeric variables', () => {
    expect(validateEnv(COMPLETE)).toEqual({
      PORT: 3000,
      INTERNAL_TOKEN: 'local-internal-token',
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      RABBITMQ_URL: 'amqp://seatly:seatly@rabbitmq:5672',
      CORE_API_URL: 'http://api:8000',
      WEB_ORIGIN: ['http://localhost:5173'],
    });
  });

  it.each([
    'INTERNAL_TOKEN',
    'REDIS_HOST',
    'REDIS_PORT',
    'RABBITMQ_URL',
    'CORE_API_URL',
    'WEB_ORIGIN',
  ])('refuses to start without %s and names it in the message', (variable) => {
    expect(() => validateEnv(without(variable))).toThrow(variable);
  });

  it('defaults PORT to 3000 rather than demanding it', () => {
    expect(validateEnv(without('PORT')).PORT).toBe(3000);
  });

  it('rejects an empty INTERNAL_TOKEN, which would disable the internal guard', () => {
    expect(() => validateEnv({ ...COMPLETE, INTERNAL_TOKEN: '' })).toThrow(
      'INTERNAL_TOKEN',
    );
  });

  it('rejects a non-numeric REDIS_PORT instead of coercing it to NaN', () => {
    expect(() => validateEnv({ ...COMPLETE, REDIS_PORT: 'abc' })).toThrow(
      'REDIS_PORT',
    );
  });

  it('rejects a CORE_API_URL that is not a url, which would make every warm fail', () => {
    expect(() =>
      validateEnv({ ...COMPLETE, CORE_API_URL: 'api:8000' }),
    ).toThrow('CORE_API_URL');
  });

  it('splits WEB_ORIGIN into a trimmed list of exact origins', () => {
    expect(
      validateEnv({
        ...COMPLETE,
        WEB_ORIGIN: ' http://localhost:5173 , https://seatly.test ',
      }).WEB_ORIGIN,
    ).toEqual(['http://localhost:5173', 'https://seatly.test']);
  });

  it.each(['*', '', ',', 'localhost:5173', 'http://localhost:5173/'])(
    'rejects WEB_ORIGIN %j, which would match no browser origin or every one',
    (value) => {
      expect(() => validateEnv({ ...COMPLETE, WEB_ORIGIN: value })).toThrow(
        'WEB_ORIGIN',
      );
    },
  );

  it('tolerates unrelated environment variables, which the whole process env carries', () => {
    expect(() =>
      validateEnv({ ...COMPLETE, HOME: '/root', PATH: '/usr/bin' }),
    ).not.toThrow();
  });
});
