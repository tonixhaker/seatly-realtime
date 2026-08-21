import { IncomingMessage } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';

class OriginIoAdapter extends IoAdapter {
  constructor(
    app: INestApplication,
    private readonly origins: string[],
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.origins },
      allowRequest: (
        req: IncomingMessage,
        callback: (err: string | null | undefined, success: boolean) => void,
      ) => {
        const origin = req.headers.origin;
        const allowed = origin === undefined || this.origins.includes(origin);
        callback(allowed ? null : 'origin not allowed', allowed);
      },
    });
  }
}

export function applyCors(app: INestApplication, origins: string[]): void {
  app.enableCors({
    origin: origins,
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
  });
  app.useWebSocketAdapter(new OriginIoAdapter(app, origins));
}
