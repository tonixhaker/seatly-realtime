import { createServer, Server } from 'node:http';

export type CoreStubMode = 'ok' | 'empty' | 'missing' | 'broken' | 'garbage';

export class CoreStub {
  private readonly server: Server;
  private calls = 0;
  private mode: CoreStubMode = 'ok';
  private seats: unknown[] = [];

  constructor() {
    this.server = createServer((request, response) => {
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

  get callCount(): number {
    return this.calls;
  }

  reset(): void {
    this.calls = 0;
    this.mode = 'ok';
    this.seats = [];
  }
}
