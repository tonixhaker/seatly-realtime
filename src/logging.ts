import { randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { LoggerModule } from 'nestjs-pino';

const REQUEST_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const UNLOGGED_PATHS = ['/health', '/health/live'];

const requestIdOf = (header: string | string[] | undefined): string =>
  typeof header === 'string' && REQUEST_ID.test(header) ? header : randomUUID();

const pathOf = (req: IncomingMessage): string => (req.url ?? '').split('?')[0];

export const loggerModule = LoggerModule.forRoot({
  pinoHttp: [
    {
      quietReqLogger: true,
      customAttributeKeys: { reqId: 'request_id' },
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const id = requestIdOf(req.headers['x-request-id']);
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: {
        ignore: (req: IncomingMessage) => UNLOGGED_PATHS.includes(pathOf(req)),
      },
      serializers: {
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    },
    process.stdout,
  ],
});
