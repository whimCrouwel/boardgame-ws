# boardgame-ws

Game-agnostic WebSocket server SDK for turn-based multiplayer boardgames.
Rooms with shareable join codes, ordered message relay, opaque state
snapshots, presence, chat, and reconnection — game rules stay in your
clients; the server never interprets game state.

## Install

```bash
npm install boardgame-ws
```

## Usage

```ts
import { GameServer } from "boardgame-ws";

const server = new GameServer({
  maxPlayersPerRoom: 6,       // default 8
  reconnectGraceMs: 120_000,  // default 2 min
  roomTtlMs: 600_000,         // default 10 min
});

const port = await server.listen(8080);
console.log(`listening on ${port}`);

server.on("roomCreated", (code) => console.log("room", code));
```

Or attach to an existing HTTP server: `server.attach(httpServer)`.

Clients speak the documented JSON protocol over a plain WebSocket — no
client SDK required. See [PROTOCOL.md](./PROTOCOL.md).

## Development

```bash
npm test          # vitest
npm run typecheck
npm run build
```
