# WebSocket Library for Multiplayer Boardgames — Design

**Date:** 2026-06-12
**Status:** Approved

## Summary

A reusable, game-agnostic **server SDK** (TypeScript, Node.js) for turn-based
multiplayer boardgame web apps, plus a **documented JSON wire protocol** that
any WebSocket client can implement. The server manages rooms with shareable
join codes, ordered message relay, opaque state snapshots, presence, chat,
and reconnection. Game rules live entirely in clients; the server never
interprets game state.

## Goals

- Create a room, share a short join code, friends join and play.
- Reliable, ordered move delivery: a move is never lost or applied twice.
- Reconnection with state recovery (close laptop, come back, resume).
- Presence events, host room controls (lock/kick/limits), and in-room chat.
- Game-agnostic: the wire protocol is the contract; no client SDK shipped.

## Non-goals

- Client SDK or React hooks (clients implement the documented protocol).
- Server-side game rule validation or cheat prevention.
- Persistence across server restarts (in-memory only; rooms die on restart).
- Horizontal scaling / multi-instance deployment.
- Real-time action-game features (tick loops, prediction, interpolation).

## Decisions

| Decision | Choice |
|---|---|
| Scope | Reusable library (npm package), not app-specific |
| Deliverables | Server SDK + `PROTOCOL.md` wire spec |
| Server role | Game-agnostic: rooms + ordered relay + opaque snapshots |
| Foundation | Bare `ws` package; own JSON protocol (no Socket.IO/Colyseus) |
| Identity | Anonymous nickname + server-issued session token |
| Persistence | In-memory only |
| Test runner | vitest, TDD throughout |

### Why bare `ws` + own protocol

The documented wire protocol is the product: any client that can open a
plain WebSocket can play, with zero client dependency. Socket.IO would force
socket.io-client on every consumer and hide the wire format. Colyseus's
schema-based sync assumes the server understands game state, which
contradicts the opaque-snapshot model. The cost — implementing acks,
ordering, heartbeats, and reconnect ourselves — is modest for turn-based
message rates and is precisely what makes this a library worth shipping.

## Architecture

One npm package with four internal units, each independently testable:

| Unit | Responsibility | Knows nothing about |
|---|---|---|
| **Transport** | Wraps `ws`: connections, heartbeat ping/pong, JSON parse/serialize, payload size limits, backpressure | Rooms, sessions |
| **Session manager** | Issues session tokens, maps connections → player sessions, runs the reconnect grace window | Game state, room rules |
| **Room manager** | Join codes, membership/seats, host role and powers, lock state, player limits, empty-room TTL | Transport details |
| **Message router** | Validates an incoming parsed message against session + room rules; triggers relay, snapshot, chat, presence | `ws` internals |

## Wire protocol

All messages are JSON text frames. Full message-by-message detail lives in
`PROTOCOL.md` (written during implementation); this section defines the
mechanics the protocol guarantees.

### Envelope

```jsonc
// client → server
{ "type": "move", "reqId": 17, "payload": { /* game-defined */ } }

// server → client (room broadcast)
{ "type": "move", "seq": 42, "playerId": "p_abc", "payload": { /* ... */ } }
```

### Mechanics

- **Request acks (`reqId`):** Every client request carries a client-chosen
  incrementing ID. The server replies `{ type: "ack", reqId }` or
  `{ type: "error", reqId, code, message }`. The server dedupes by
  `(session, reqId)`, so a client resending after a network hiccup never
  causes a move to apply twice.
- **Ordered broadcast (`seq`):** The server stamps every room broadcast with
  a per-room incrementing sequence number. Clients detect gaps and send
  `sync.request` to recover.
- **Snapshots:** Any client (by convention the host) sends `snapshot.set`
  with an opaque state blob plus the `seq` it reflects. The server stores
  only the latest. On join/reconnect the server sends `snapshot` (blob +
  seq) followed by any later broadcasts.
- **Heartbeat:** WebSocket ping/pong every 15s. Two consecutive misses mark
  the connection dropped, which starts the reconnect grace window (it does
  not remove the player).

### Message catalog

| Direction | Types |
|---|---|
| client → server | `hello`, `room.create`, `room.join`, `room.leave`, `move`, `chat`, `snapshot.set`, `room.lock`, `room.unlock`, `room.kick`, `sync.request` |
| server → client | `ack`, `error`, `welcome`, `room.created`, `room.joined`, `move`, `chat`, `snapshot`, `presence`, `room.locked`, `room.unlocked`, `room.closed` |

`presence` carries an event field: `join`, `leave`, `disconnect`,
`reconnect`, or `kick`.

## Identity and reconnection

- First `hello` → server replies `welcome` with a new `playerId` and a
  random `sessionToken`. The client persists the token (e.g., localStorage).
- Later connections send `hello` with the token; the server restores the
  same `playerId`. Nickname is a field on `hello`, relayed via presence.
- On drop: the player is marked `disconnected` (presence event broadcast)
  and a grace window starts (default 2 min, configurable). Returning with
  the token inside the window reseats the player: they receive
  `room.joined` with the current snapshot plus subsequent broadcasts, and
  the room sees a `reconnect` presence event.
- Window expiry removes the player like a normal leave. Rejoining a
  non-locked room afterward via the join code is a fresh join.

## Rooms

- `room.create` → 6-character join code from an unambiguous alphabet
  (no `0/O`, `1/I`). Creator becomes host.
- `room.join` succeeds if the room exists, is not locked, and is not full
  (configurable max, default 8). Late joiners immediately receive the
  latest snapshot; games decide whether to treat them as players or
  spectators.
- Host powers: `room.lock` / `room.unlock`, `room.kick`. If the host is
  permanently removed, host transfers to the longest-seated member.
- A room with zero connected members for the configured TTL (default
  10 min) is closed and its code freed.

## Server API

```ts
import { GameServer } from "boardgame-ws"; // working name

const server = new GameServer({
  maxPlayersPerRoom: 6,        // all options optional
  reconnectGraceMs: 120_000,
  roomTtlMs: 600_000,
});
server.listen(8080);            // or server.attach(httpServer)
```

Observability hooks for logging/metrics, listeners only:
`server.on("roomCreated" | "roomClosed" | "playerJoined" | "playerLeft" |
"playerDisconnected" | "playerReconnected", handler)`.

## Error handling

- Error codes: `ROOM_NOT_FOUND`, `ROOM_LOCKED`, `ROOM_FULL`, `NOT_HOST`,
  `INVALID_MESSAGE`, `RATE_LIMITED`, `BAD_TOKEN`.
- Malformed JSON or unknown message types → `error`; repeat offenders are
  disconnected.
- Per-connection rate limit, default 20 messages/sec.
- Payload caps: 64KB per message, 256KB for snapshots. Oversized frames are
  rejected with `INVALID_MESSAGE`.

## Testing

- **Unit tests** per module (room manager, session manager, router) against
  a fake transport — no real sockets; fast and deterministic.
- **Integration tests** run the real server on a random port with actual
  `ws` clients, covering join → move → disconnect → reconnect →
  snapshot-recovery end to end.
- Timer behavior (grace window, room TTL) tested with fake timers.
- TDD throughout; vitest as the runner.
