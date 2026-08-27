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

The two `/holds` routes take an **optional** bearer token, validated by asking
`seatly-api` for `GET /api/v1/me` and cached for 60 seconds. With a token the hold records
the buyer's user id; with none the caller is an anonymous guest identified by `session_id`
alone. A token `seatly-api` rejects is `401`, never a silent guest, and a token that cannot
be checked at all because `seatly-api` is unreachable is `503 AUTH_STATE_UNAVAILABLE`.

WebSocket — namespace `/events`, emitting `snapshot`, `seat.held`, `seat.released` and
`seat.sold`. The protocol is specified in [`docs/websocket.md`](docs/websocket.md).

Ops — `GET /health/live` answers liveness without touching a dependency, `GET /health`
answers readiness by pinging Redis and RabbitMQ and returns `503` when either is
unreachable. Both are unauthenticated and absent from the OpenAPI document.

## Running standalone

Needs Node 22 and pnpm, plus three things around it, each at an environment variable:

- Redis 7 at `REDIS_HOST` / `REDIS_PORT`, started with `notify-keyspace-events Ex` —
  without that flag hold expiry goes unnoticed.
- RabbitMQ at `RABBITMQ_URL`, where `seatly-api` publishes its domain events.
- [seatly-api](https://github.com/tonixhaker/seatly-api) at `CORE_API_URL`, for bearer-token
  validation and for warming the sold-seat cache.

Throwaway Redis and RabbitMQ matching `.env.example`:

```bash
docker run -d --name seatly-redis -p 6379:6379 redis:7 redis-server --notify-keyspace-events Ex
docker run -d --name seatly-rabbitmq -p 5672:5672 \
  -e RABBITMQ_DEFAULT_USER=seatly -e RABBITMQ_DEFAULT_PASS=seatly rabbitmq:3-management
```

```bash
pnpm install
cp .env.example .env
pnpm start:dev
```

Serves on `http://localhost:3000`, and `/internal/*` on `http://localhost:3001` only. Configuration is validated against a zod schema at
startup, so a missing or malformed variable stops the process with a message naming it
rather than failing on first use. `.env` is required by every entry point that boots the
application, including `pnpm openapi`.

| Variable | Required | Consumed by |
|---|---|---|
| `PORT` | defaults to `3000` | the HTTP server and the socket.io endpoint |
| `INTERNAL_PORT` | defaults to `3001` | a second listener that alone answers `/internal/*`, which is 404 on `PORT`; must differ from `PORT`, and is never published |
| `INTERNAL_TOKEN` | yes | the `X-Internal-Token` guard on `/internal/*`; must equal `seatly-api`'s `INTERNAL_TOKEN` |
| `REDIS_HOST` | yes | hold storage and expiry, and the readiness probe |
| `REDIS_PORT` | yes | as above |
| `RABBITMQ_URL` | yes | the domain-event consumer, and the readiness probe |
| `CORE_API_URL` | yes | token validation and warming `sold:{eventId}` from `seatly-api`; must carry an `http`/`https` scheme |
| `WEB_ORIGIN` | yes | CORS on the HTTP routes and the socket.io handshake; a comma-separated list of exact browser origins such as `http://localhost:5173`, no `*`, no path or trailing slash |

### With Docker

```bash
docker build -t seatly-realtime .
docker run -d -p 3000:3000 \
  -e INTERNAL_TOKEN=local-internal-token \
  -e REDIS_HOST=host.docker.internal -e REDIS_PORT=6379 \
  -e RABBITMQ_URL=amqp://seatly:seatly@host.docker.internal:5672 \
  -e CORE_API_URL=http://host.docker.internal:8000 \
  -e WEB_ORIGIN=http://localhost:5173 \
  seatly-realtime
```

`3001` is deliberately not published: only services on the same network should reach
`/internal/*`.

The image builds from this repository alone, runs Node 22 as the unprivileged `node` user,
and carries no development dependency and no `.env` — every variable is supplied at run
time. Its own `HEALTHCHECK` polls `/health/live`, so a container started without Redis or
RabbitMQ still reports healthy; readiness is what `/health` answers. `docker stop` shuts
the process down gracefully rather than waiting for the timeout.

## Tests

`pnpm test` runs the unit specs and needs nothing running. `pnpm test:e2e` needs the Redis
and RabbitMQ above for its healthy-readiness cases.

## License

MIT — see [LICENSE](LICENSE).
