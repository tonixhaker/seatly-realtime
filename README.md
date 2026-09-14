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

## Running it

Needs Node 22, pnpm, RabbitMQ, a reachable `seatly-api` for token validation, and Redis 7
started with `notify-keyspace-events Ex` — without that flag hold expiry goes unnoticed.

```bash
pnpm install
cp .env.example .env
pnpm start:dev
```

Serves on `http://localhost:3000`.

## Status

Work in progress. Not runnable yet.

## License

MIT
