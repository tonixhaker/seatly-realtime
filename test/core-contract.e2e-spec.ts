import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_SEATS, CoreStub } from './support/core-stub';

interface PropertySchema {
  type: 'integer' | 'string';
}

interface ObjectSchema {
  properties: Record<string, PropertySchema>;
  required: string[];
}

const contract = JSON.parse(
  readFileSync(join(__dirname, 'support', 'core-contract.json'), 'utf8'),
) as Record<string, ObjectSchema>;

const violations = (schema: ObjectSchema, body: unknown): string[] => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return [`expected an object, got ${typeof body}`];
  }

  const value = body as Record<string, unknown>;
  const found = Object.keys(value).sort();
  const expected = [...schema.required].sort();
  const failures: string[] = [];

  if (found.join(',') !== expected.join(',')) {
    failures.push(
      `key set is [${found.join(',')}], contract says [${expected.join(',')}]`,
    );
  }

  for (const [name, property] of Object.entries(schema.properties)) {
    if (!(name in value)) {
      continue;
    }

    const actual = value[name];
    const ok =
      property.type === 'integer'
        ? Number.isInteger(actual)
        : typeof actual === 'string';

    if (!ok) {
      failures.push(
        `${name} is ${typeof actual}, contract says ${property.type}`,
      );
    }
  }

  return failures;
};

describe("the core stub against seatly-api's committed contract", () => {
  let core: CoreStub;
  let base: string;

  beforeAll(async () => {
    core = new CoreStub();
    base = await core.start();
  });

  afterAll(async () => {
    await core.stop();
  });

  it('carries both response schemas, so the checks below are not vacuous', () => {
    expect(Object.keys(contract).sort()).toEqual([
      'SeatResource',
      'UserResource',
    ]);
    expect(contract.UserResource.required).toHaveLength(4);
    expect(contract.SeatResource.required).toHaveLength(9);
  });

  it('rejects a body that does not match, so the validator itself discriminates', () => {
    expect(violations(contract.UserResource, { id: 4 })).not.toEqual([]);
    expect(
      violations(contract.UserResource, {
        id: '4',
        name: 'n',
        email: 'e',
        role: 'r',
      }),
    ).toEqual(['id is string, contract says integer']);
  });

  it('answers GET /api/v1/me with a body shaped like UserResource', async () => {
    core.accept('contract-token');

    const response = await fetch(`${base}/api/v1/me`, {
      headers: { Authorization: 'Bearer contract-token' },
    });

    expect(response.status).toBe(200);
    expect(violations(contract.UserResource, await response.json())).toEqual(
      [],
    );
  });

  it('answers GET /api/v1/events/{id}/seats with bodies shaped like SeatResource', async () => {
    core.serve(CORE_SEATS);

    const response = await fetch(`${base}/api/v1/events/1/seats`);
    const seats = (await response.json()) as unknown[];

    expect(response.status).toBe(200);
    expect(seats.length).toBeGreaterThan(0);

    for (const seat of seats) {
      expect(violations(contract.SeatResource, seat)).toEqual([]);
    }
  });
});
