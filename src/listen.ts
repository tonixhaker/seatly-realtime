import { INestApplication } from '@nestjs/common';
import { once } from 'node:events';
import { createServer, RequestListener, Server } from 'node:http';

export async function listen(
  app: INestApplication,
  port: number,
  internalPort: number,
): Promise<Server> {
  await app.listen(port);
  const internal = createServer(
    app.getHttpAdapter().getInstance() as RequestListener,
  );
  (app.getHttpServer() as Server).once('close', () => {
    internal.close();
  });
  internal.listen(internalPort);
  await once(internal, 'listening');
  return internal;
}
