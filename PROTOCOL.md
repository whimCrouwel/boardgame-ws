# boardgame-ws Wire Protocol v0.1

All messages are JSON objects sent as WebSocket text frames.

## Envelope

Client → server messages carry a client-chosen `reqId` (positive integer,
strictly increasing **per session**). The server answers every request
with either `{"type":"ack","reqId":N}` or
`{"type":"error","reqId":N,"code":"...","message":"..."}`.

If you resend a request with a `reqId` the server has already processed, it
re-sends the previous ack/error and does **not** apply the request again —
safe retry after a network hiccup.

Server → room broadcasts carry a per-room strictly increasing `seq`. If you
observe a gap in `seq`, send `sync.request` to recover.

**Important:** the reqId sequence belongs to the *session*, not the connection.
When you reconnect with a session token, continue the counter where it left
off (e.g., persist it alongside the token). A reqId at or below the highest
one the server has seen replays the previous response and is otherwise
ignored.

## Connecting

1. Open a WebSocket to the server.
2. Send `{"type":"hello","reqId":1,"nickname":"Alice"}`.
   To resume a previous identity, include `"token"` from a prior `welcome`.
3. Receive `ack`, then `{"type":"welcome","playerId":"p_..","token":".."}`.
   Persist `token` (e.g., localStorage) to survive reloads.
4. If your session was in a room, you immediately also receive `room.joined`,
   then `snapshot` (if one exists), then any broadcasts newer than the
   snapshot.

The server pings every 15s; standard WebSocket implementations pong
automatically. Missing two pings drops the connection (and starts the
reconnect grace window — default 2 minutes — during which your seat is held).

## Client → server messages

| Type | Fields | Notes |
|---|---|---|
| `hello` | `token?`, `nickname?` (1–32 chars when present) | Must be first message |
| `room.create` | — | Creator becomes host |
| `room.join` | `code` (6 chars, case-insensitive) | |
| `room.leave` | — | |
| `move` | `payload` (any JSON) | Relayed verbatim, never interpreted |
| `chat` | `text` (1–2000 chars) | |
| `snapshot.set` | `seq`, `state` (any JSON) | `seq` = last seq reflected in `state`; must not regress below the stored snapshot's seq |
| `sync.request` | — | Re-sends snapshot + newer broadcasts |
| `room.lock` / `room.unlock` | — | Host only |
| `room.kick` | `playerId` | Host only |

Size caps: 64KB per message, 256KB for `snapshot.set`.
Rate limit: 20 messages/second per connection.

Frames larger than 256KB are dropped at the transport layer — the connection
is closed without an `INVALID_MESSAGE` reply.

## Server → client messages

| Type | Fields | Notes |
|---|---|---|
| `ack` | `reqId` | |
| `error` | `reqId` (may be null), `code`, `message` | |
| `welcome` | `playerId`, `token` | |
| `room.created` | `code`, `members` | To creator only |
| `room.joined` | `code`, `you`, `members`, `locked` | To joiner; follows `ack` |
| `move` | `seq`, `playerId`, `payload` | Broadcast (sender included) |
| `chat` | `seq`, `playerId`, `text` | Broadcast |
| `snapshot` | `seq`, `state` | On join/reconnect/sync.request |
| `presence` | `seq`, `event`, `playerId`, `nickname`, `newHost?` | `event` ∈ join, leave, disconnect, reconnect, kick |
| `room.locked` / `room.unlocked` | `seq`, `playerId` | Broadcast |
| `room.closed` | — | Room was closed |

`members` entries: `{ playerId, nickname, connected, host }`.

Note: after joining, your own `join` presence may appear in the catch-up
stream — clients should ignore presence events about themselves.

## Error codes

`ROOM_NOT_FOUND`, `ROOM_LOCKED`, `ROOM_FULL`, `NOT_HOST`, `INVALID_MESSAGE`,
`RATE_LIMITED`, `BAD_TOKEN`.

## Recommended client flow for a boardgame

- Host creates the room, shares the code, and calls `room.lock` when the
  game starts.
- Send game actions as `move`; apply them in `seq` order on every client.
- Have the host send `snapshot.set` after each completed turn so late
  joiners and reconnecting players recover instantly.
- On any `seq` gap, send `sync.request` and reapply from the snapshot.
