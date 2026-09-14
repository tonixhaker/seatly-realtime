# seatly-realtime

Seat holds and live seat state for Seatly, an event ticketing platform with real-time
seat selection.

Holds seats in Redis for ten minutes, broadcasts seat state over WebSocket, and consumes
domain events from [seatly-api](https://github.com/tonixhaker/seatly-api).

## Stack

- Node 22, NestJS 11
- Redis 7 via `ioredis`
- socket.io
- RabbitMQ consumer

## Interfaces

REST — `POST /holds`, `DELETE /holds`, `GET /events/{id}/live-seats`, and
`GET /internal/holds/validate` on the internal network. OpenAPI via `@nestjs/swagger`.

WebSocket — namespace `/events`, emitting `snapshot`, `seat.held`, `seat.released` and
`seat.sold`. The protocol is specified in [`docs/websocket.md`](docs/websocket.md).

Ops — `GET /health/live` answers liveness without touching a dependency, `GET /health`
answers readiness by pinging Redis and RabbitMQ and returns `503` when either is
unreachable. Both are unauthenticated and absent from the OpenAPI document.

## Running it

Needs Node 22, pnpm, RabbitMQ, a reachable `seatly-api` for token validation, and Redis 7
started with `notify-keyspace-events Ex` — without that flag hold expiry goes unnoticed.

```bash
pnpm install
cp .env.example .env
pnpm start:dev
```

Serves on `http://localhost:3000`. Configuration is validated against a zod schema at
startup, so a missing or malformed variable stops the process with a message naming it
rather than failing on first use. `.env` is required by every entry point that boots the
application, including `pnpm openapi`.

| Variable | Required | Consumed by |
|---|---|---|
| `PORT` | defaults to `3000` | the HTTP server |
| `INTERNAL_TOKEN` | yes | the `X-Internal-Token` guard on `/internal/*` |
| `REDIS_HOST` | yes | the readiness probe, and holds from milestone 04 |
| `REDIS_PORT` | yes | as above |
| `RABBITMQ_URL` | yes | the readiness probe, and the consumer from milestone 05 |

### Tests

`pnpm test` runs the unit specs. `pnpm test:e2e` needs a reachable Redis and RabbitMQ for
its healthy-readiness cases:

```bash
docker run -d -p 6379:6379 redis:7 redis-server --notify-keyspace-events Ex
docker run -d -p 5672:5672 --user rabbitmq \
  -e RABBITMQ_DEFAULT_USER=seatly -e RABBITMQ_DEFAULT_PASS=seatly rabbitmq:3-management
```

## Status

Work in progress. Not runnable yet.

## License

MIT
