import { ConfigService } from '@nestjs/config';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AUTH_CACHE_MAX_ENTRIES,
  AUTH_CACHE_TTL_MS,
  TokenAuthService,
} from './token-auth.service';

const CORE = 'http://127.0.0.1:8000';
const TOKEN = '10|khxAUOcdtRA8JRoovg4t4cds8kEK740Tn0Xw7XWv51d62278';
const OTHER_TOKEN = '11|cwOCSiOeAgk0xdwEhiYj4zY9D5iFI3rHRbbJfNbN890f0413';

const BUYER = {
  id: 4,
  name: 'Iris Janssen',
  email: 'buyer@seatly.test',
  role: 'buyer',
};

const ORGANIZER = {
  id: 2,
  name: 'Otto Vermeer',
  email: 'organizer1@seatly.test',
  role: 'organizer',
};

const answers = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const unauthorized = (): Response =>
  answers(
    { error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } },
    401,
  );

describe('TokenAuthService', () => {
  let auth: TokenAuthService;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  let now: number;

  const config = {
    get: () => CORE,
  } as unknown as ConfigService<{ CORE_API_URL: string }, true>;

  beforeEach(() => {
    now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    auth = new TokenAuthService(config);
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the user id core reported', async () => {
    fetchSpy.mockResolvedValue(answers(BUYER));

    expect(await auth.userIdFor(TOKEN)).toBe(BUYER.id);
  });

  it('sends the token to core as a verbatim bearer header', async () => {
    fetchSpy.mockResolvedValue(answers(BUYER));

    await auth.userIdFor(TOKEN);

    expect(fetchSpy.mock.calls[0][0]).toBe(`${CORE}/api/v1/me`);
    expect(fetchSpy.mock.calls[0][1]?.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
    });
    expect(fetchSpy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('calls core once for the same token used twice inside the window', async () => {
    fetchSpy.mockResolvedValue(answers(BUYER));

    expect(await auth.userIdFor(TOKEN)).toBe(BUYER.id);
    now += AUTH_CACHE_TTL_MS - 1;
    expect(await auth.userIdFor(TOKEN)).toBe(BUYER.id);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by the token, so two tokens in one window get their own identity', async () => {
    fetchSpy.mockImplementation((_input, init) =>
      Promise.resolve(
        (init?.headers as Record<string, string>).authorization ===
          `Bearer ${TOKEN}`
          ? answers(BUYER)
          : answers(ORGANIZER),
      ),
    );

    expect(await auth.userIdFor(TOKEN)).toBe(BUYER.id);
    expect(await auth.userIdFor(OTHER_TOKEN)).toBe(ORGANIZER.id);
    expect(await auth.userIdFor(TOKEN)).toBe(BUYER.id);
    expect(await auth.userIdFor(OTHER_TOKEN)).toBe(ORGANIZER.id);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('calls core again once the window has passed', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(answers(BUYER)));

    await auth.userIdFor(TOKEN);
    now += AUTH_CACHE_TTL_MS + 1;
    await auth.userIdFor(TOKEN);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects a token core answered 401 for, and never asks twice about it', async () => {
    fetchSpy.mockResolvedValue(unauthorized());

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(auth.userIdFor(TOKEN)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('re-asks core about a rejected token once the window has passed', async () => {
    fetchSpy.mockResolvedValue(unauthorized());

    await expect(auth.userIdFor(TOKEN)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    now += AUTH_CACHE_TTL_MS + 1;
    await expect(auth.userIdFor(TOKEN)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a core 500', (): Response => answers({ error: {} }, 500)],
    ['a core 503', (): Response => answers({ error: {} }, 503)],
    ['a body that is not json', (): Response => new Response('<html>')],
    ['a body with no id', (): Response => answers({ name: 'Iris' })],
    ['a body whose id is not a number', (): Response => answers({ id: 'x' })],
  ])('reports %s as unverifiable and never caches it', async (_label, make) => {
    fetchSpy.mockImplementation(() => Promise.resolve(make()));

    await expect(auth.userIdFor(TOKEN)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(auth.userIdFor(TOKEN)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('reports an unreachable core as unverifiable and never caches it', async () => {
    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(auth.userIdFor(TOKEN)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(auth.userIdFor(TOKEN)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('answers a failure with AUTH_STATE_UNAVAILABLE and no trace of the token', async () => {
    fetchSpy.mockRejectedValue(new Error(`connect ECONNREFUSED ${TOKEN}`));

    const failure = await auth.userIdFor(TOKEN).then(
      () => {
        throw new Error('the unreachable core should have been reported');
      },
      (error: unknown) => error as ServiceUnavailableException,
    );

    expect(failure.getResponse()).toEqual({
      code: 'AUTH_STATE_UNAVAILABLE',
      message: expect.any(String) as string,
    });
    expect(JSON.stringify(failure.getResponse())).not.toContain(TOKEN);
  });

  it('bounds the cache, so a flood of unknown tokens cannot grow it without limit', async () => {
    fetchSpy.mockResolvedValue(answers(BUYER));
    expect(await auth.userIdFor(TOKEN)).toBe(BUYER.id);

    fetchSpy.mockResolvedValue(unauthorized());
    for (let entry = 0; entry < AUTH_CACHE_MAX_ENTRIES; entry += 1) {
      await auth.userIdFor(`flood-${String(entry)}`).catch(() => undefined);
    }

    fetchSpy.mockClear();
    fetchSpy.mockResolvedValue(answers(BUYER));
    expect(await auth.userIdFor(TOKEN)).toBe(BUYER.id);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
