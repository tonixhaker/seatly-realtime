import { createServer, Server } from 'node:http';

export type CoreStubMode = 'ok' | 'empty' | 'missing' | 'broken' | 'garbage';

export type CoreStubMeMode = 'ok' | 'unauthorized' | 'broken' | 'down';

export interface CoreStubUser {
  id: number;
  name: string;
  email: string;
  role: string;
}

export const DEFAULT_USER: CoreStubUser = {
  id: 4,
  name: 'Iris Janssen',
  email: 'buyer@seatly.test',
  role: 'buyer',
};

export const CORE_SEATS = [
  {
    id: 1,
    section: 'Front Stalls',
    row: 1,
    number: 1,
    x: 40,
    y: 45,
    price_cents: 8500,
    currency: 'EUR',
    status: 'free',
  },
  {
    id: 2,
    section: 'Front Stalls',
    row: 1,
    number: 2,
    x: 80,
    y: 45,
    price_cents: 8500,
    currency: 'EUR',
    status: 'sold',
  },
  {
    id: 3,
    section: 'Front Stalls',
    row: 1,
    number: 3,
    x: 120,
    y: 45,
    price_cents: 8500,
    currency: 'EUR',
    status: 'free',
  },
  {
    id: 4,
    section: 'Front Stalls',
    row: 1,
    number: 4,
    x: 160,
    y: 45,
    price_cents: 8500,
    currency: 'EUR',
    status: 'sold',
  },
];

export class CoreStub {
  private readonly server: Server;
  private calls = 0;
  private meCalls = 0;
  private mode: CoreStubMode = 'ok';
  private meMode: CoreStubMeMode = 'ok';
  private readonly users = new Map<string, CoreStubUser>();
  private seats: unknown[] = [];

  public lastAuthorization: string | undefined;

  constructor() {
    this.server = createServer((request, response) => {
      if ((request.url ?? '').endsWith('/api/v1/me')) {
        this.meCalls += 1;
        this.lastAuthorization = request.headers.authorization;

        if (this.meMode === 'down') {
          request.socket.destroy();
          return;
        }

        if (this.meMode === 'broken') {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }));
          return;
        }

        const user = this.users.get(this.lastAuthorization ?? '');

        if (this.meMode === 'unauthorized' || user === undefined) {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              error: {
                code: 'UNAUTHENTICATED',
                message: 'Authentication is required to access this resource.',
              },
            }),
          );
          return;
        }

        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(user));
        return;
      }

      this.calls += 1;

      if (this.mode === 'missing') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: { code: 'NOT_FOUND', message: 'Not found.' },
          }),
        );
        return;
      }

      if (this.mode === 'broken') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }));
        return;
      }

      if (this.mode === 'garbage') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: 'not a seat array' }));
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(this.mode === 'empty' ? [] : this.seats));
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );

    const address = this.server.address() as { port: number };

    return `http://127.0.0.1:${String(address.port)}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  serve(seats: unknown[], mode: CoreStubMode = 'ok'): void {
    this.seats = seats;
    this.mode = mode;
  }

  answer(mode: CoreStubMode): void {
    this.mode = mode;
  }

  accept(token: string, user: Partial<CoreStubUser> = {}): CoreStubUser {
    const identity = { ...DEFAULT_USER, ...user };
    this.users.set(`Bearer ${token}`, identity);
    return identity;
  }

  answerMe(mode: CoreStubMeMode): void {
    this.meMode = mode;
  }

  get callCount(): number {
    return this.calls;
  }

  get meCallCount(): number {
    return this.meCalls;
  }

  reset(): void {
    this.calls = 0;
    this.meCalls = 0;
    this.mode = 'ok';
    this.meMode = 'ok';
    this.users.clear();
    this.lastAuthorization = undefined;
    this.seats = [];
  }
}
