import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const COMPOSE_SERVICES = [
  'postgres',
  'redis',
  'rabbitmq',
  'api',
  'realtime',
  'web',
];

const hostOf = (value: string): string => {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
};

const parse = (contents: string): [string, string][] =>
  contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=');

      return [line.slice(0, separator), line.slice(separator + 1)];
    });

const variables = parse(
  readFileSync(join(__dirname, '..', '.env.example'), 'utf8'),
);

describe('.env.example', () => {
  it('carries the variables the service needs, so the check below is not vacuous', () => {
    expect(variables.map(([name]) => name)).toEqual(
      expect.arrayContaining(['REDIS_HOST', 'REDIS_PORT', 'RABBITMQ_URL']),
    );
  });

  it.each(variables)(
    'points %s at a host reachable outside compose, not a compose service name',
    (_name, value) => {
      expect(COMPOSE_SERVICES).not.toContain(hostOf(value));
    },
  );
});
