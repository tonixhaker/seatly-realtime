# WebSocket protocol

The socket.io contract of `seatly-realtime`: how a client subscribes to one event's seats
and how the server pushes seat state to it.

## 1. Scope

This document is the contract. There is no generator behind it — socket.io has no OpenAPI
equivalent — so the server and the client are both implemented against this file and
against nothing else. If a rule is not written here, it is not part of the protocol.

The REST surface of this service is specified separately, in `docs/openapi.json`. The two
are complementary: state is changed over REST and observed over the socket (§9).

Nothing described here is implemented yet. `POST /holds`, `DELETE /holds` and
`GET /events/{id}/live-seats` already exist as fixture handlers; the socket does not.

## 2. Connection

| | |
|---|---|
| Transport | socket.io v4 (Engine.IO protocol 4) |
| Path | `/socket.io/` — the socket.io default, not overridden |
| Namespace | `/events` |
| Origin | `http://<host>:<port>`, port from `PORT`, `3000` in local development |
| Client URL | `http://localhost:3000/events` in local development |
| Handshake auth | none — see §10 |

Transport negotiation stays at the socket.io default: HTTP long-polling first, upgraded to
WebSocket. Neither side pins a transport.

**Message encoding.** Every event carries exactly one argument: a JSON object with the
fields listed in §4 and §5, and no others. There is no envelope, no `version` field, no
message id and no timestamp — unlike the RabbitMQ messages this service consumes, which do
have an envelope. Do not add one here by analogy.

**Field naming is `snake_case`**, the same as the REST surface and the RabbitMQ payloads.
No field in this protocol is `camelCase`.

The browser client is served from a different origin in development, so the socket.io
server must allow that origin. Which origins are allowed is deployment configuration, not
protocol, and is not specified here.

## 3. Rooms

There is exactly one room shape: `event:{event_id}` — for example `event:42`.

- Membership is established only by `join` (§4). There is no auto-join on connect, no
  server-initiated room assignment and no presence.
- A socket may join several event rooms. Each `join` adds one room and produces its own
  `snapshot`, and every server-to-client payload carries `event_id` so the client can route
  a message to the right event without tracking which socket it arrived on.
- There is no `leave`. A client that has lost interest in an event stops applying that
  event's deltas, or disconnects.
- **socket.io does not restore room membership across a reconnect.** A reconnected client
  is a new socket in no room at all. That is why step 3 of §8 is not optional.

## 4. Client to server

One message. There is no other.

| Event | Payload | Effect |
|---|---|---|
| `join` | `{ event_id }` | Joins the room `event:{event_id}` |

`event_id` is a JSON number, an integer `>= 1` — the same identifier the REST surface uses
and the same `events.id` the core service publishes. Never a string.

- **The server joins the room first, then reads state and emits the `snapshot`.** The order
  matters: a delta broadcast in the window between the two is then applied twice by that
  client, which is harmless (§7), whereas reading state before joining loses it silently.
  That lost update is the bug a reader writes if this sentence is missing.
- **There is no acknowledgement callback.** The `snapshot` is the acknowledgement. A client
  waiting for an ack waits forever.
- **`join` is idempotent.** Repeating it for an event the socket already joined sends
  another fresh `snapshot` and changes nothing else. This is what makes §8 work.
- **A malformed or invalid `join`** — `event_id` missing, not an integer, or below 1 — joins
  no room and emits nothing. There is no error event in this protocol, so there is nothing
  else the server could send; it logs the attempt at `warn` level. A client that receives no
  `snapshot` treats the join as failed and retries on its own backoff.
- An `event_id` that exists but has no held or sold seats — including one that does not
  exist at all — produces a `snapshot` with two empty arrays.

**There is no client-to-server message other than `join`.** No `hold`, no `release`, no
`leave`, no application-level `ping`. See §9.

## 5. Server to client

Four messages, and only four.

| Event | Payload |
|---|---|
| `snapshot` | `{ event_id, held: number[], sold: number[] }` |
| `seat.held` | `{ event_id, seat_ids: number[], session_id }` |
| `seat.released` | `{ event_id, seat_ids: number[] }` |
| `seat.sold` | `{ event_id, seat_ids: number[] }` |

Types, everywhere in this protocol:

| Field | Type | Rules |
|---|---|---|
| `event_id` | integer | `>= 1` |
| `seat_ids`, `held`, `sold` | array of integer | each `>= 1`, unique within the array |
| `session_id` | string | UUID, issued by the web client |

No field is ever `null` and no field is ever absent. Seat id order carries no meaning and is
not stable — treat every seat id array here as a set. The only arrays that may be empty are
`held` and `sold` in a `snapshot`; a delta always carries at least one seat id.

**Every delta goes to the whole room, including the socket of the session that caused it.**
The cause arrived over REST and may not share a connection with any socket at all, so the
server excludes no one. A client that took a hold still receives the matching `seat.held`
and needs no separate local path for its own changes.

A client ignores event names it does not recognise.

### `snapshot`

`{ event_id, held: number[], sold: number[] }`

The complete state of one event's seats: every seat currently held, and every seat sold.
**The two arrays are disjoint** — a seat id appears in at most one of them — and a seat id in
neither is free. Seats themselves are not enumerated; the client already has the seat map
from the core service's `GET /events/{id}/seats`.

**Emitted:** immediately after a successful `join`, to the joining socket only. After a
reconnect too, because a reconnect re-joins. The server emits it at no other time.

**Client action:** replace local state for that `event_id` entirely (§6).

`held` is the **complete** held set for the event, the client's own holds included, and the
snapshot deliberately does not say whose they are — attributing them would tell every client
in the room who holds what. A client that needs to restore its own cart after a reload keeps
its `session_id` and its own seat ids locally; it issued both, and it must persist
`session_id` anyway to place an order. Do not wait for a field that never arrives.

`snapshot` is the one payload in this protocol that grows with venue size, and no
application-level size cap applies to it. The other three are bounded indirectly: each
derives from a single hold request, and the REST surface caps `seat_ids` at 50.

### `seat.held`

`{ event_id, seat_ids: number[], session_id }`

**Emitted:** when a session acquires a hold — the broadcast that follows a successful
`POST /holds`. A hold lives for ten minutes.

`seat_ids` carries the seats of **that request only**, never the session's full hold set. A
cumulative payload would force every observer to diff it against what they already had.

**Client action:** add `seat_ids` to the held set. Compare `session_id` against the
`session_id` the client issued for itself: equal means these are the client's own holds, in
its own cart; different means the seats are taken by somebody else.

**`seat.held` carries `session_id` and the other three messages do not.** That asymmetry is
the point of the field. `seat.held` is the only event whose meaning depends on who caused
it. A release and a sale look identical from every client's point of view — a freed seat is
free for everyone and a sold seat is sold for everyone — so neither is scoped to a session
and neither needs the field.

### `seat.released`

`{ event_id, seat_ids: number[] }`

**Emitted:** when held seats stop being held without being sold.

**It covers two causes and does not say which:** a session released the seats deliberately
(`DELETE /holds`), or the hold's ten-minute TTL ran out. The client cannot distinguish them
and does not need to — the seats are free again either way. Do not add a reason field to
work around this; the ambiguity is deliberate.

Expiry is observed through Redis keyspace notifications on the hold keys, not by polling, so
an expiry is broadcast within the notification's latency of the TTL rather than on a tick.
A client may run its own ten-minute countdown for the cart display, but that countdown is
advisory: this message is what actually frees the seats.

**Client action:** remove `seat_ids` from the held set. Seats already known sold stay sold.

### `seat.sold`

`{ event_id, seat_ids: number[] }`

**Emitted:** when the seats are paid for, as the service consumes the `order.paid` domain
message. `event_id` and `seat_ids` come straight from that message's payload; `order_id` and
`buyer_id` are dropped, because no client may learn who bought a seat. The consumer
deduplicates, so a redelivered message does not produce a second broadcast — and if one
slipped through, §7 absorbs it.

**Client action:** add `seat_ids` to the sold set and remove them from the held set.

Sold is terminal. No later message returns a sold seat to free.

## 6. Snapshot against delta — the conflict rule

A client keeps two sets per joined event, `held` and `sold`, and derives a seat's state:

| In `sold` | In `held` | State |
|---|---|---|
| yes | — | `sold` |
| no | yes | `held` |
| no | no | `free` |

Each message is applied exactly like this:

| Message | `held` | `sold` |
|---|---|---|
| `snapshot` | **replaced** by `held` | **replaced** by `sold` |
| `seat.held` | add `seat_ids` | unchanged |
| `seat.released` | remove `seat_ids` | unchanged |
| `seat.sold` | remove `seat_ids` | add `seat_ids` |

Two rules follow, and both are load-bearing:

1. **A snapshot replaces local state entirely; a delta mutates it.** A snapshot is not merged
   into what the client already holds, and local entries are not kept on the grounds that the
   snapshot "did not mention them". Both sets are overwritten.
2. **When a snapshot and a delta disagree, the snapshot wins, without merging.** There is no
   reconciliation step, no timestamp comparison and no version counter anywhere in this
   protocol. The snapshot is the newer truth and what the client believed a moment earlier is
   discarded.

It follows that two snapshots never need reconciling either: the later one is simply the
state.

## 7. Ordering and delivery

- Messages sent on one connection arrive in emission order. Nothing is guaranteed across a
  disconnect.
- **There is no replay.** Deltas emitted while a client was disconnected are gone. They are
  not buffered, not re-sent and not summarised.
- Delivery is at-most-once. There are no sequence numbers, no message ids and no acks, and
  none are needed: every delta is an idempotent set operation, so applying one twice leaves
  the same state as applying it once.
- Convergence comes from the `snapshot` on join and re-join, never from the delta stream.
- Deltas for an event the client has not joined are never sent. If one arrives anyway, ignore
  it.

## 8. Reconnect

The client reconnects. The server does nothing special for a returning socket — it cannot
even tell that it is one.

1. Detect the disconnect. Keep the local state; it is stale, but it is better than an empty
   seat map while the client is reconnecting.
2. Reconnect with exponential backoff. The socket.io client defaults are the contract:
   initial delay 1000 ms, multiplier 2, capped at 5000 ms, randomisation factor 0.5,
   unlimited attempts. Leave `reconnection` enabled and do not hand-roll a second retry loop
   on top of it.
3. On `connect`, send `join` again for every event the client wants. Room membership does not
   survive a disconnect (§3).
4. Wait for the `snapshot` the server sends in response to each `join`.
5. Apply that snapshot over whatever local state survived the outage, replacing it (§6).
6. Resume applying deltas.

**A client must never assume it can resume where it left off.** The snapshot in step 4 is the
only way back to a correct view, which is why step 3 is not optional.

## 9. Holds are taken over REST, not over the socket

The socket is read-only from the client's side. The only thing a client sends is `join`.

| Action | Call |
|---|---|
| Take a hold | `POST /holds` with `{event_id, seat_ids, session_id}` |
| Release a hold | `DELETE /holds` with the same body |
| Read current state without a socket | `GET /events/{id}/live-seats` → `{held, sold}` |
| Buy the held seats | `POST /orders` on the core service |

Taking a hold needs a status code and an error envelope — a seat may already be held by
somebody else — and a fire-and-forget socket event has neither. So no `hold` event exists on
the socket. Do not go looking for one.

`GET /events/{id}/live-seats` returns the same two arrays as a `snapshot`, without the
`event_id`. It is there for a client that renders the seat map before its socket is up; a
client with a socket receives the same state in the `snapshot` on join and does not need
both.

## 10. Not covered here

- **Authentication and authorisation of the socket connection.** The handshake carries no
  token and the server checks nothing at connect time: anyone who can reach the service can
  join any `event:{id}` room and watch its held and sold seat ids. Note the consequence —
  `session_id` is broadcast in `seat.held` to everyone in the room, so it is an identifier
  and not a secret, and it authorises nothing by itself. The `X-Internal-Token` guard on the
  REST surface covers `/internal/*` only and has nothing to do with the socket. Socket
  authentication is a later decision.
- **Any room other than `event:{id}`.** No per-session room, no per-user room, no global
  broadcast channel. A feature that needs one extends this document first.
- **Server-to-client errors.** There are four server-to-client events and no fifth. A failure
  is reported by the REST call that caused it, never over the socket.
- **Delivery guarantees beyond the above.** No redelivery, no replay buffer, no message ids.
- **Allowed origins and the rest of the deployment configuration.**
- **Broadcasting across more than one server instance.** The protocol on the wire is the
  same; how the fan-out is achieved is not specified here.
- **Rate limiting of `join`.** Long-lived connections are exempt from the per-request
  throttling the REST surface uses.
