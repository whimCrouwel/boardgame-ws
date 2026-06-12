# boardgame-ws MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MVP of `boardgame-ws` — a game-agnostic WebSocket server SDK for turn-based multiplayer boardgames, per the spec at `docs/superpowers/specs/2026-06-12-websocket-multiplayer-library-design.md`.

**Architecture:** Four units behind a small public API: a protocol parser (validates raw JSON into typed client messages), a `RoomManager`/`Room` (join codes, membership, host, seq, snapshot + broadcast buffer), a `SessionManager` (tokens, identity), and a `Router` that wires them to abstract `Connection` objects. `GameServer` binds the router to real `ws` sockets and adds heartbeat + rate limiting. Unit tests drive the router through fake connections; integration tests use real sockets.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), `ws`, `vitest`. Node ≥ 20.

---

## File map

| File | Responsibility |
|---|---|
| `src/types.ts` | `ClientMessage`, `ServerMessage`, `ErrorCode`, `MemberInfo`, `PresenceEvent` |
| `src/protocol.ts` | `parseClientMessage(raw)` — JSON parse + per-type validation + size caps |
| `src/codes.ts` | `generateJoinCode()` — 6 chars, unambiguous alphabet |
| `src/session.ts` | `SessionManager`, `Session` — tokens, playerIds, dedupe fields |
| `src/room.ts` | `Room`, `RoomManager` — membership, host transfer, seq, snapshot/buffer |
| `src/router.ts` | `Router`, `Connection` — all message handling, timers (grace, TTL) |
| `src/server.ts` | `GameServer` — `ws` wiring, heartbeat, rate limit, event re-emit |
| `src/index.ts` | Public exports |
| `tests/helpers/fake.ts` | `FakeConnection`, `FakePlayer` for router unit tests |
| `tests/helpers/client.ts` | `TestClient` for integration tests (real sockets) |
| `PROTOCOL.md` | Client-facing wire protocol documentation |

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.gitignore`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "boardgame-ws",
  "version": "0.1.0",
  "description": "Game-agnostic WebSocket server SDK for turn-based multiplayer boardgames",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist", "PROTOCOL.md"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Write `tsconfig.json`** (typecheck config — covers src and tests, no emit)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Write `tsconfig.build.json`** (emit config — src only)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Write `.gitignore`**

```
node_modules/
dist/
```

- [ ] **Step 5: Install dependencies**

Run: `npm install ws && npm install -D typescript vitest @types/ws @types/node`
Expected: both commands exit 0; `package-lock.json` created.

- [ ] **Step 6: Verify toolchain**

Run: `npx vitest run`
Expected: exits with "No test files found" (this is correct — no tests yet).
Run: `npm run typecheck`
Expected: exits 0 (nothing to check yet).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json .gitignore
git commit -m "chore: scaffold TypeScript + vitest project"
```

---

### Task 2: Protocol types and parser

**Files:**
- Create: `src/types.ts`, `src/protocol.ts`
- Test: `tests/protocol.test.ts`

- [ ] **Step 1: Write the failing tests** — `tests/protocol.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { parseClientMessage } from "../src/protocol.js";

describe("parseClientMessage", () => {
  it("rejects invalid JSON", () => {
    const r = parseClientMessage("not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reqId).toBeNull();
  });

  it("rejects messages without a positive integer reqId", () => {
    expect(parseClientMessage(JSON.stringify({ type: "move" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: "move", reqId: 0 })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: "move", reqId: 1.5 })).ok).toBe(false);
  });

  it("rejects unknown types, echoing the reqId", () => {
    const r = parseClientMessage(JSON.stringify({ type: "teleport", reqId: 7 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reqId).toBe(7);
  });

  it("parses a hello with nickname", () => {
    const r = parseClientMessage(JSON.stringify({ type: "hello", reqId: 1, nickname: "Alice" }));
    expect(r).toEqual({
      ok: true,
      message: { type: "hello", reqId: 1, token: undefined, nickname: "Alice" },
    });
  });

  it("parses a move with arbitrary payload", () => {
    const r = parseClientMessage(JSON.stringify({ type: "move", reqId: 2, payload: { x: 1 } }));
    expect(r).toEqual({ ok: true, message: { type: "move", reqId: 2, payload: { x: 1 } } });
  });

  it("requires move to carry a payload", () => {
    expect(parseClientMessage(JSON.stringify({ type: "move", reqId: 2 })).ok).toBe(false);
  });

  it("requires room.join code to be 6 characters", () => {
    expect(parseClientMessage(JSON.stringify({ type: "room.join", reqId: 1, code: "ABC" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: "room.join", reqId: 1, code: "ABCDEF" })).ok).toBe(true);
  });

  it("limits chat text to 2000 chars", () => {
    expect(parseClientMessage(JSON.stringify({ type: "chat", reqId: 1, text: "hi" })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: "chat", reqId: 1, text: "x".repeat(2001) })).ok).toBe(false);
  });

  it("rejects non-snapshot messages over 64KB", () => {
    const r = parseClientMessage(
      JSON.stringify({ type: "move", reqId: 1, payload: "x".repeat(65 * 1024) }),
    );
    expect(r.ok).toBe(false);
  });

  it("allows snapshots up to 256KB", () => {
    const r = parseClientMessage(
      JSON.stringify({ type: "snapshot.set", reqId: 1, seq: 0, state: "x".repeat(100 * 1024) }),
    );
    expect(r.ok).toBe(true);
  });

  it("parses bare-body types", () => {
    for (const type of ["room.create", "room.leave", "room.lock", "room.unlock", "sync.request"]) {
      expect(parseClientMessage(JSON.stringify({ type, reqId: 3 }))).toEqual({
        ok: true,
        message: { type, reqId: 3 },
      });
    }
  });

  it("parses room.kick with a playerId", () => {
    expect(parseClientMessage(JSON.stringify({ type: "room.kick", reqId: 4, playerId: "p_x" }))).toEqual({
      ok: true,
      message: { type: "room.kick", reqId: 4, playerId: "p_x" },
    });
    expect(parseClientMessage(JSON.stringify({ type: "room.kick", reqId: 4 })).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/protocol.test.ts`
Expected: FAIL — cannot resolve `../src/protocol.js`.

- [ ] **Step 3: Write `src/types.ts`**

```ts
export type ErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_LOCKED"
  | "ROOM_FULL"
  | "NOT_HOST"
  | "INVALID_MESSAGE"
  | "RATE_LIMITED"
  | "BAD_TOKEN";

export type PresenceEvent = "join" | "leave" | "disconnect" | "reconnect" | "kick";

export interface MemberInfo {
  playerId: string;
  nickname: string;
  connected: boolean;
  host: boolean;
}

export type ClientMessage =
  | { type: "hello"; reqId: number; token?: string; nickname?: string }
  | { type: "room.create"; reqId: number }
  | { type: "room.join"; reqId: number; code: string }
  | { type: "room.leave"; reqId: number }
  | { type: "move"; reqId: number; payload: unknown }
  | { type: "chat"; reqId: number; text: string }
  | { type: "snapshot.set"; reqId: number; seq: number; state: unknown }
  | { type: "room.lock"; reqId: number }
  | { type: "room.unlock"; reqId: number }
  | { type: "room.kick"; reqId: number; playerId: string }
  | { type: "sync.request"; reqId: number };

export type ServerMessage =
  | { type: "ack"; reqId: number }
  | { type: "error"; reqId: number | null; code: ErrorCode; message: string }
  | { type: "welcome"; playerId: string; token: string }
  | { type: "room.created"; code: string; members: MemberInfo[] }
  | { type: "room.joined"; code: string; you: string; members: MemberInfo[]; locked: boolean }
  | { type: "move"; seq: number; playerId: string; payload: unknown }
  | { type: "chat"; seq: number; playerId: string; text: string }
  | { type: "snapshot"; seq: number; state: unknown }
  | { type: "presence"; seq: number; event: PresenceEvent; playerId: string; nickname: string; newHost?: string }
  | { type: "room.locked"; seq: number; playerId: string }
  | { type: "room.unlocked"; seq: number; playerId: string }
  | { type: "room.closed" };
```

- [ ] **Step 4: Write `src/protocol.ts`**

```ts
import type { ClientMessage } from "./types.js";

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024;

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; reqId: number | null; error: string };

function fail(reqId: number | null, error: string): ParseResult {
  return { ok: false, reqId, error };
}

export function parseClientMessage(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fail(null, "invalid JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return fail(null, "message must be an object");
  }
  const msg = data as Record<string, unknown>;
  const reqId =
    typeof msg.reqId === "number" && Number.isInteger(msg.reqId) && msg.reqId > 0 ? msg.reqId : null;
  if (reqId === null) return fail(null, "reqId must be a positive integer");
  if (typeof msg.type !== "string") return fail(reqId, "type must be a string");

  const cap = msg.type === "snapshot.set" ? MAX_SNAPSHOT_BYTES : MAX_MESSAGE_BYTES;
  if (Buffer.byteLength(raw) > cap) return fail(reqId, `message exceeds ${cap} byte limit`);

  switch (msg.type) {
    case "hello":
      if (msg.token !== undefined && typeof msg.token !== "string") {
        return fail(reqId, "token must be a string");
      }
      if (msg.nickname !== undefined && (typeof msg.nickname !== "string" || msg.nickname.length > 32)) {
        return fail(reqId, "nickname must be a string of at most 32 chars");
      }
      return {
        ok: true,
        message: {
          type: "hello",
          reqId,
          token: msg.token as string | undefined,
          nickname: msg.nickname as string | undefined,
        },
      };
    case "room.create":
    case "room.leave":
    case "room.lock":
    case "room.unlock":
    case "sync.request":
      return { ok: true, message: { type: msg.type, reqId } };
    case "room.join":
      if (typeof msg.code !== "string" || msg.code.length !== 6) {
        return fail(reqId, "code must be a 6-character string");
      }
      return { ok: true, message: { type: "room.join", reqId, code: msg.code } };
    case "move":
      if (!("payload" in msg)) return fail(reqId, "payload is required");
      return { ok: true, message: { type: "move", reqId, payload: msg.payload } };
    case "chat":
      if (typeof msg.text !== "string" || msg.text.length === 0 || msg.text.length > 2000) {
        return fail(reqId, "text must be a string of 1-2000 chars");
      }
      return { ok: true, message: { type: "chat", reqId, text: msg.text } };
    case "snapshot.set":
      if (typeof msg.seq !== "number" || !Number.isInteger(msg.seq) || msg.seq < 0) {
        return fail(reqId, "seq must be a non-negative integer");
      }
      if (!("state" in msg)) return fail(reqId, "state is required");
      return { ok: true, message: { type: "snapshot.set", reqId, seq: msg.seq, state: msg.state } };
    case "room.kick":
      if (typeof msg.playerId !== "string") return fail(reqId, "playerId must be a string");
      return { ok: true, message: { type: "room.kick", reqId, playerId: msg.playerId } };
    default:
      return fail(reqId, `unknown message type: ${msg.type}`);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/protocol.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/protocol.ts tests/protocol.test.ts
git commit -m "feat: protocol message types and parser with validation and size caps"
```

---

### Task 3: Join code generator

**Files:**
- Create: `src/codes.ts`
- Test: `tests/codes.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/codes.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { generateJoinCode } from "../src/codes.js";

describe("generateJoinCode", () => {
  it("produces 6 chars from the unambiguous alphabet (no 0/O/1/I)", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateJoinCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/codes.test.ts`
Expected: FAIL — cannot resolve `../src/codes.js`.

- [ ] **Step 3: Write `src/codes.ts`**

```ts
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateJoinCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/codes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/codes.ts tests/codes.test.ts
git commit -m "feat: join code generator with unambiguous alphabet"
```

---

### Task 4: Session manager

**Files:**
- Create: `src/session.ts`
- Test: `tests/session.test.ts`

- [ ] **Step 1: Write the failing tests** — `tests/session.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/session.js";

describe("SessionManager", () => {
  it("creates sessions with distinct ids and tokens", () => {
    const mgr = new SessionManager();
    const a = mgr.create("A");
    const b = mgr.create("B");
    expect(a.playerId).not.toBe(b.playerId);
    expect(a.token).not.toBe(b.token);
    expect(a.playerId).toMatch(/^p_[0-9a-f]{8}$/);
    expect(a.nickname).toBe("A");
    expect(a.roomCode).toBeNull();
    expect(a.lastReqId).toBe(0);
  });

  it("resumes by token and looks up by playerId", () => {
    const mgr = new SessionManager();
    const a = mgr.create("A");
    expect(mgr.resume(a.token)).toBe(a);
    expect(mgr.resume("nope")).toBeUndefined();
    expect(mgr.get(a.playerId)).toBe(a);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/session.test.ts`
Expected: FAIL — cannot resolve `../src/session.js`.

- [ ] **Step 3: Write `src/session.ts`**

```ts
import { randomBytes } from "node:crypto";
import type { ServerMessage } from "./types.js";

export interface Session {
  playerId: string;
  token: string;
  nickname: string;
  roomCode: string | null;
  lastReqId: number;
  lastResponse: ServerMessage | null;
  connected: boolean;
}

export class SessionManager {
  private byToken = new Map<string, Session>();
  private byId = new Map<string, Session>();

  create(nickname: string): Session {
    const session: Session = {
      playerId: `p_${randomBytes(4).toString("hex")}`,
      token: randomBytes(16).toString("hex"),
      nickname,
      roomCode: null,
      lastReqId: 0,
      lastResponse: null,
      connected: false,
    };
    this.byToken.set(session.token, session);
    this.byId.set(session.playerId, session);
    return session;
  }

  resume(token: string): Session | undefined {
    return this.byToken.get(token);
  }

  get(playerId: string): Session | undefined {
    return this.byId.get(playerId);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session.ts tests/session.test.ts
git commit -m "feat: session manager with token-based identity"
```

---

### Task 5: Room and RoomManager

**Files:**
- Create: `src/room.ts`
- Test: `tests/room.test.ts`

- [ ] **Step 1: Write the failing tests** — `tests/room.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { Room, RoomManager } from "../src/room.js";

describe("Room", () => {
  const make = () => new Room("ABC234", "p_host", "Hosty");

  it("seats the creator as host", () => {
    const room = make();
    expect(room.memberInfos()).toEqual([
      { playerId: "p_host", nickname: "Hosty", connected: true, host: true },
    ]);
  });

  it("transfers host to the longest-seated member when the host leaves", () => {
    const room = make();
    room.addMember("p_b", "B");
    room.addMember("p_c", "C");
    expect(room.removeMember("p_host")).toEqual({ hostChanged: true, newHostId: "p_b" });
    expect(room.hostId).toBe("p_b");
  });

  it("does not change host when a non-host leaves", () => {
    const room = make();
    room.addMember("p_b", "B");
    expect(room.removeMember("p_b")).toEqual({ hostChanged: false, newHostId: null });
  });

  it("stamps increasing seq numbers", () => {
    const room = make();
    expect(room.nextSeq()).toBe(1);
    expect(room.nextSeq()).toBe(2);
  });

  it("buffers broadcasts and drops those covered by a snapshot", () => {
    const room = make();
    room.record({ type: "move", seq: room.nextSeq(), playerId: "p_host", payload: 1 });
    room.record({ type: "move", seq: room.nextSeq(), playerId: "p_host", payload: 2 });
    room.setSnapshot({ board: "x" }, 1);
    expect(room.buffer.map((m) => m.seq)).toEqual([2]);
    expect(room.catchUp()).toEqual([
      { type: "snapshot", seq: 1, state: { board: "x" } },
      { type: "move", seq: 2, playerId: "p_host", payload: 2 },
    ]);
  });

  it("catchUp without a snapshot returns just the buffer", () => {
    const room = make();
    room.record({ type: "move", seq: room.nextSeq(), playerId: "p_host", payload: 1 });
    expect(room.catchUp()).toEqual([{ type: "move", seq: 1, playerId: "p_host", payload: 1 }]);
  });

  it("counts connected members", () => {
    const room = make();
    room.addMember("p_b", "B");
    room.members.get("p_b")!.connected = false;
    expect(room.connectedCount()).toBe(1);
  });
});

describe("RoomManager", () => {
  it("creates rooms with codes and looks them up", () => {
    const mgr = new RoomManager();
    const room = mgr.create("p_1", "A");
    expect(room.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(mgr.get(room.code)).toBe(room);
    mgr.close(room.code);
    expect(mgr.get(room.code)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/room.test.ts`
Expected: FAIL — cannot resolve `../src/room.js`.

- [ ] **Step 3: Write `src/room.ts`**

```ts
import { generateJoinCode } from "./codes.js";
import type { MemberInfo, ServerMessage } from "./types.js";

export type Broadcast = Extract<ServerMessage, { seq: number }>;

export interface Member {
  playerId: string;
  nickname: string;
  connected: boolean;
  joinedAt: number;
}

export class Room {
  readonly code: string;
  hostId: string;
  locked = false;
  seq = 0;
  snapshot: { state: unknown; seq: number } | null = null;
  buffer: Broadcast[] = [];
  members = new Map<string, Member>();
  private joinCounter = 0;

  constructor(code: string, hostId: string, hostNickname: string) {
    this.code = code;
    this.hostId = hostId;
    this.addMember(hostId, hostNickname);
  }

  addMember(playerId: string, nickname: string): void {
    this.members.set(playerId, {
      playerId,
      nickname,
      connected: true,
      joinedAt: this.joinCounter++,
    });
  }

  removeMember(playerId: string): { hostChanged: boolean; newHostId: string | null } {
    this.members.delete(playerId);
    if (playerId !== this.hostId || this.members.size === 0) {
      return { hostChanged: false, newHostId: null };
    }
    let next: Member | null = null;
    for (const m of this.members.values()) {
      if (!next || m.joinedAt < next.joinedAt) next = m;
    }
    this.hostId = next!.playerId;
    return { hostChanged: true, newHostId: this.hostId };
  }

  memberInfos(): MemberInfo[] {
    return [...this.members.values()].map((m) => ({
      playerId: m.playerId,
      nickname: m.nickname,
      connected: m.connected,
      host: m.playerId === this.hostId,
    }));
  }

  nextSeq(): number {
    return ++this.seq;
  }

  record(msg: Broadcast): void {
    this.buffer.push(msg);
  }

  setSnapshot(state: unknown, seq: number): void {
    this.snapshot = { state, seq };
    this.buffer = this.buffer.filter((m) => m.seq > seq);
  }

  catchUp(): ServerMessage[] {
    const msgs: ServerMessage[] = [];
    if (this.snapshot) msgs.push({ type: "snapshot", seq: this.snapshot.seq, state: this.snapshot.state });
    return [...msgs, ...this.buffer];
  }

  connectedCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.connected) n++;
    return n;
  }
}

export class RoomManager {
  rooms = new Map<string, Room>();

  create(hostId: string, hostNickname: string): Room {
    let code = generateJoinCode();
    while (this.rooms.has(code)) code = generateJoinCode();
    const room = new Room(code, hostId, hostNickname);
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  close(code: string): void {
    this.rooms.delete(code);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/room.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/room.ts tests/room.test.ts
git commit -m "feat: room with host transfer, seq stream, snapshot and broadcast buffer"
```

---

### Task 6: Router — hello and room membership

**Files:**
- Create: `src/router.ts`, `tests/helpers/fake.ts`
- Test: `tests/router-rooms.test.ts`

- [ ] **Step 1: Write the test helpers** — `tests/helpers/fake.ts`

```ts
import type { Connection, Router } from "../../src/router.js";
import type { ServerMessage } from "../../src/types.js";

export class FakeConnection implements Connection {
  sent: ServerMessage[] = [];
  closed = false;

  send(msg: ServerMessage): void {
    this.sent.push(msg);
  }

  close(): void {
    this.closed = true;
  }

  last(): ServerMessage {
    return this.sent[this.sent.length - 1];
  }

  ofType(type: ServerMessage["type"]): ServerMessage[] {
    return this.sent.filter((m) => m.type === type);
  }

  clear(): void {
    this.sent = [];
  }
}

export class FakePlayer {
  conn = new FakeConnection();
  playerId = "";
  token = "";
  private reqId = 0;

  constructor(private router: Router) {}

  send(partial: Record<string, unknown>): number {
    const reqId = ++this.reqId;
    this.router.handleMessage(this.conn, JSON.stringify({ ...partial, reqId }));
    return reqId;
  }

  hello(nickname = "Player", token?: string): void {
    this.send(token === undefined ? { type: "hello", nickname } : { type: "hello", nickname, token });
    const welcome = this.conn.sent.filter((m) => m.type === "welcome").at(-1) as
      | Extract<ServerMessage, { type: "welcome" }>
      | undefined;
    if (welcome) {
      this.playerId = welcome.playerId;
      this.token = welcome.token;
    }
  }
}
```

- [ ] **Step 2: Write the failing tests** — `tests/router-rooms.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { Router } from "../src/router.js";
import type { ServerMessage } from "../src/types.js";
import { FakePlayer } from "./helpers/fake.js";

function setup() {
  const router = new Router();
  const host = new FakePlayer(router);
  host.hello("Hosty");
  host.send({ type: "room.create" });
  const created = host.conn.ofType("room.created")[0] as Extract<
    ServerMessage,
    { type: "room.created" }
  >;
  return { router, host, code: created.code };
}

describe("Router: hello", () => {
  it("issues an ack and a welcome with playerId and token", () => {
    const router = new Router();
    const p = new FakePlayer(router);
    p.hello("Alice");
    expect(p.conn.ofType("ack")).toHaveLength(1);
    expect(p.playerId).toMatch(/^p_/);
    expect(p.token).toHaveLength(32);
  });

  it("rejects unknown tokens with BAD_TOKEN", () => {
    const router = new Router();
    const p = new FakePlayer(router);
    p.send({ type: "hello", token: "bogus" });
    expect(p.conn.last()).toMatchObject({ type: "error", code: "BAD_TOKEN" });
  });

  it("rejects non-hello messages before hello", () => {
    const router = new Router();
    const p = new FakePlayer(router);
    p.send({ type: "room.create" });
    expect(p.conn.last()).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
  });

  it("resuming with a token restores the same playerId", () => {
    const router = new Router();
    const p = new FakePlayer(router);
    p.hello("Alice");
    const original = p.playerId;
    const p2 = new FakePlayer(router);
    p2.hello("Alice", p.token);
    expect(p2.playerId).toBe(original);
  });
});

describe("Router: rooms", () => {
  it("creates a room with the creator as host", () => {
    const { host, code } = setup();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(host.conn.ofType("room.created")[0]).toMatchObject({
      members: [{ playerId: host.playerId, host: true }],
    });
  });

  it("lets a second player join and notifies the host with presence", () => {
    const { router, host, code } = setup();
    const guest = new FakePlayer(router);
    guest.hello("Guest");
    guest.send({ type: "room.join", code });
    expect(guest.conn.ofType("room.joined")[0]).toMatchObject({ code, you: guest.playerId });
    expect(host.conn.ofType("presence")[0]).toMatchObject({ event: "join", playerId: guest.playerId });
  });

  it("join codes are case-insensitive", () => {
    const { router, code } = setup();
    const guest = new FakePlayer(router);
    guest.hello();
    guest.send({ type: "room.join", code: code.toLowerCase() });
    expect(guest.conn.ofType("room.joined")).toHaveLength(1);
  });

  it("rejects joining a missing room", () => {
    const { router } = setup();
    const guest = new FakePlayer(router);
    guest.hello();
    guest.send({ type: "room.join", code: "ZZZZZZ" });
    expect(guest.conn.last()).toMatchObject({ type: "error", code: "ROOM_NOT_FOUND" });
  });

  it("rejects joining a full room", () => {
    const router = new Router({ maxPlayersPerRoom: 2 });
    const host = new FakePlayer(router);
    host.hello();
    host.send({ type: "room.create" });
    const code = (host.conn.ofType("room.created")[0] as { code: string }).code;
    const g1 = new FakePlayer(router);
    g1.hello();
    g1.send({ type: "room.join", code });
    const g2 = new FakePlayer(router);
    g2.hello();
    g2.send({ type: "room.join", code });
    expect(g2.conn.last()).toMatchObject({ type: "error", code: "ROOM_FULL" });
  });

  it("rejects creating while already in a room", () => {
    const { host } = setup();
    host.send({ type: "room.create" });
    expect(host.conn.last()).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
  });

  it("broadcasts leave presence with host transfer", () => {
    const { router, host, code } = setup();
    const guest = new FakePlayer(router);
    guest.hello("Guest");
    guest.send({ type: "room.join", code });
    host.send({ type: "room.leave" });
    expect(guest.conn.ofType("presence").at(-1)).toMatchObject({
      event: "leave",
      playerId: host.playerId,
      newHost: guest.playerId,
    });
  });

  it("closes the room when the last member leaves", () => {
    const { router, host, code } = setup();
    host.send({ type: "room.leave" });
    const guest = new FakePlayer(router);
    guest.hello();
    guest.send({ type: "room.join", code });
    expect(guest.conn.last()).toMatchObject({ type: "error", code: "ROOM_NOT_FOUND" });
  });

  it("emits lifecycle events", () => {
    const events: string[] = [];
    const router = new Router(
      {},
      {
        roomCreated: (code) => events.push(`created:${code}`),
        playerJoined: (code, pid) => events.push(`joined:${pid}`),
        roomClosed: (code) => events.push(`closed:${code}`),
      },
    );
    const p = new FakePlayer(router);
    p.hello();
    p.send({ type: "room.create" });
    p.send({ type: "room.leave" });
    expect(events).toHaveLength(3);
    expect(events[1]).toBe(`joined:${p.playerId}`);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/router-rooms.test.ts`
Expected: FAIL — cannot resolve `../src/router.js`.

- [ ] **Step 4: Write `src/router.ts`**

Note the `default` branch in the switch: gameplay and host-control message types parse successfully but aren't handled until Tasks 7–8.

```ts
import { parseClientMessage } from "./protocol.js";
import { Room, RoomManager, type Broadcast } from "./room.js";
import { SessionManager, type Session } from "./session.js";
import type { ClientMessage, ServerMessage } from "./types.js";

export interface Connection {
  send(msg: ServerMessage): void;
  close(): void;
}

export interface RouterEvents {
  roomCreated?: (code: string) => void;
  roomClosed?: (code: string) => void;
  playerJoined?: (code: string, playerId: string) => void;
  playerLeft?: (code: string, playerId: string) => void;
  playerDisconnected?: (code: string, playerId: string) => void;
  playerReconnected?: (code: string, playerId: string) => void;
}

export interface RouterOptions {
  maxPlayersPerRoom: number;
  reconnectGraceMs: number;
  roomTtlMs: number;
}

type Msg<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;
type Reply = (response: ServerMessage) => void;

export class Router {
  private opts: RouterOptions;
  private sessions = new SessionManager();
  private rooms = new RoomManager();
  private bySession = new Map<Connection, Session>();
  private connOf = new Map<string, Connection>();
  private graceTimers = new Map<string, NodeJS.Timeout>();
  private ttlTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    opts: Partial<RouterOptions> = {},
    private events: RouterEvents = {},
  ) {
    this.opts = {
      maxPlayersPerRoom: opts.maxPlayersPerRoom ?? 8,
      reconnectGraceMs: opts.reconnectGraceMs ?? 120_000,
      roomTtlMs: opts.roomTtlMs ?? 600_000,
    };
  }

  /** Returns false when the raw message failed to parse (for abuse tracking). */
  handleMessage(conn: Connection, raw: string): boolean {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      conn.send({ type: "error", reqId: parsed.reqId, code: "INVALID_MESSAGE", message: parsed.error });
      return false;
    }
    const msg = parsed.message;
    if (msg.type === "hello") {
      this.onHello(conn, msg);
      return true;
    }
    const session = this.bySession.get(conn);
    if (!session) {
      conn.send({ type: "error", reqId: msg.reqId, code: "INVALID_MESSAGE", message: "hello required first" });
      return true;
    }
    if (msg.reqId <= session.lastReqId) {
      if (session.lastResponse) conn.send(session.lastResponse);
      return true;
    }
    const reply: Reply = (response) => {
      session.lastReqId = msg.reqId;
      session.lastResponse = response;
      conn.send(response);
    };
    switch (msg.type) {
      case "room.create":
        this.onRoomCreate(conn, session, msg, reply);
        break;
      case "room.join":
        this.onRoomJoin(conn, session, msg, reply);
        break;
      case "room.leave":
        this.onRoomLeave(session, msg, reply);
        break;
      default:
        reply({ type: "error", reqId: msg.reqId, code: "INVALID_MESSAGE", message: "unhandled message type" });
    }
    return true;
  }

  dispose(): void {
    for (const t of this.graceTimers.values()) clearTimeout(t);
    for (const t of this.ttlTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    this.ttlTimers.clear();
  }

  private onHello(conn: Connection, msg: Msg<"hello">): void {
    let session: Session;
    if (msg.token !== undefined) {
      const found = this.sessions.resume(msg.token);
      if (!found) {
        conn.send({ type: "error", reqId: msg.reqId, code: "BAD_TOKEN", message: "unknown session token" });
        return;
      }
      session = found;
      if (msg.nickname) session.nickname = msg.nickname;
      const old = this.connOf.get(session.playerId);
      if (old && old !== conn) {
        this.bySession.delete(old);
        old.close();
      }
    } else {
      session = this.sessions.create(msg.nickname ?? "Player");
    }
    this.bySession.set(conn, session);
    this.connOf.set(session.playerId, conn);
    session.connected = true;
    conn.send({ type: "ack", reqId: msg.reqId });
    conn.send({ type: "welcome", playerId: session.playerId, token: session.token });
    if (session.roomCode) this.rejoin(conn, session);
  }

  private rejoin(conn: Connection, session: Session): void {
    const room = this.rooms.get(session.roomCode!);
    const member = room?.members.get(session.playerId);
    if (!room || !member) {
      session.roomCode = null;
      return;
    }
    const wasDisconnected = !member.connected;
    member.connected = true;
    this.clearGrace(session.playerId);
    this.clearTtl(room.code);
    if (wasDisconnected) {
      this.broadcast(
        room,
        {
          type: "presence",
          seq: room.nextSeq(),
          event: "reconnect",
          playerId: session.playerId,
          nickname: session.nickname,
        },
        session.playerId,
      );
    }
    conn.send({
      type: "room.joined",
      code: room.code,
      you: session.playerId,
      members: room.memberInfos(),
      locked: room.locked,
    });
    for (const m of room.catchUp()) conn.send(m);
    if (wasDisconnected) this.events.playerReconnected?.(room.code, session.playerId);
  }

  private onRoomCreate(conn: Connection, session: Session, msg: Msg<"room.create">, reply: Reply): void {
    if (session.roomCode) {
      reply({ type: "error", reqId: msg.reqId, code: "INVALID_MESSAGE", message: "already in a room" });
      return;
    }
    const room = this.rooms.create(session.playerId, session.nickname);
    session.roomCode = room.code;
    reply({ type: "ack", reqId: msg.reqId });
    conn.send({ type: "room.created", code: room.code, members: room.memberInfos() });
    this.events.roomCreated?.(room.code);
    this.events.playerJoined?.(room.code, session.playerId);
  }

  private onRoomJoin(conn: Connection, session: Session, msg: Msg<"room.join">, reply: Reply): void {
    if (session.roomCode) {
      reply({ type: "error", reqId: msg.reqId, code: "INVALID_MESSAGE", message: "already in a room" });
      return;
    }
    const code = msg.code.toUpperCase();
    const room = this.rooms.get(code);
    if (!room) {
      reply({ type: "error", reqId: msg.reqId, code: "ROOM_NOT_FOUND", message: `no room with code ${code}` });
      return;
    }
    if (room.locked) {
      reply({ type: "error", reqId: msg.reqId, code: "ROOM_LOCKED", message: "room is locked" });
      return;
    }
    if (room.members.size >= this.opts.maxPlayersPerRoom) {
      reply({ type: "error", reqId: msg.reqId, code: "ROOM_FULL", message: "room is full" });
      return;
    }
    room.addMember(session.playerId, session.nickname);
    session.roomCode = code;
    this.clearTtl(code);
    this.broadcast(
      room,
      {
        type: "presence",
        seq: room.nextSeq(),
        event: "join",
        playerId: session.playerId,
        nickname: session.nickname,
      },
      session.playerId,
    );
    reply({ type: "ack", reqId: msg.reqId });
    conn.send({
      type: "room.joined",
      code,
      you: session.playerId,
      members: room.memberInfos(),
      locked: room.locked,
    });
    for (const m of room.catchUp()) conn.send(m);
    this.events.playerJoined?.(code, session.playerId);
  }

  private onRoomLeave(session: Session, msg: Msg<"room.leave">, reply: Reply): void {
    if (!session.roomCode) {
      reply({ type: "error", reqId: msg.reqId, code: "INVALID_MESSAGE", message: "not in a room" });
      return;
    }
    this.removeFromRoom(session, "leave");
    reply({ type: "ack", reqId: msg.reqId });
  }

  /** Removes the player and broadcasts presence; returns the presence message (null if room closed). */
  private removeFromRoom(session: Session, event: "leave" | "kick"): ServerMessage | null {
    const room = this.rooms.get(session.roomCode!);
    session.roomCode = null;
    this.clearGrace(session.playerId);
    if (!room || !room.members.has(session.playerId)) return null;
    const { hostChanged, newHostId } = room.removeMember(session.playerId);
    if (room.members.size === 0) {
      this.events.playerLeft?.(room.code, session.playerId);
      this.closeRoom(room);
      return null;
    }
    const presence: Extract<ServerMessage, { type: "presence" }> = {
      type: "presence",
      seq: room.nextSeq(),
      event,
      playerId: session.playerId,
      nickname: session.nickname,
    };
    if (hostChanged && newHostId) presence.newHost = newHostId;
    this.broadcast(room, presence);
    this.events.playerLeft?.(room.code, session.playerId);
    this.checkEmpty(room);
    return presence;
  }

  private closeRoom(room: Room): void {
    this.clearTtl(room.code);
    for (const pid of room.members.keys()) {
      const s = this.sessions.get(pid);
      if (s) {
        s.roomCode = null;
        this.clearGrace(pid);
      }
      this.connOf.get(pid)?.send({ type: "room.closed" });
    }
    this.rooms.close(room.code);
    this.events.roomClosed?.(room.code);
  }

  private checkEmpty(room: Room): void {
    if (room.connectedCount() > 0) return;
    this.clearTtl(room.code);
    this.ttlTimers.set(
      room.code,
      setTimeout(() => {
        this.ttlTimers.delete(room.code);
        const current = this.rooms.get(room.code);
        if (current && current.connectedCount() === 0) this.closeRoom(current);
      }, this.opts.roomTtlMs),
    );
  }

  private broadcast(room: Room, msg: Broadcast, exceptPlayerId?: string): void {
    room.record(msg);
    for (const [pid, member] of room.members) {
      if (!member.connected || pid === exceptPlayerId) continue;
      this.connOf.get(pid)?.send(msg);
    }
  }

  private clearGrace(playerId: string): void {
    const t = this.graceTimers.get(playerId);
    if (t) {
      clearTimeout(t);
      this.graceTimers.delete(playerId);
    }
  }

  private clearTtl(code: string): void {
    const t = this.ttlTimers.get(code);
    if (t) {
      clearTimeout(t);
      this.ttlTimers.delete(code);
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/router-rooms.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/router.ts tests/helpers/fake.ts tests/router-rooms.test.ts
git commit -m "feat: router with hello/welcome and room create/join/leave"
```

---

### Task 7: Router — gameplay (move, chat, snapshot, sync, dedupe)

**Files:**
- Modify: `src/router.ts` (add cases to the switch + four handlers + `requireRoom`)
- Test: `tests/router-gameplay.test.ts`

- [ ] **Step 1: Write the failing tests** — `tests/router-gameplay.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { Router } from "../src/router.js";
import { FakePlayer } from "./helpers/fake.js";

function table(router = new Router()) {
  const host = new FakePlayer(router);
  host.hello("Hosty");
  host.send({ type: "room.create" });
  const code = (host.conn.ofType("room.created")[0] as { code: string }).code;
  const guest = new FakePlayer(router);
  guest.hello("Guest");
  guest.send({ type: "room.join", code });
  host.conn.clear();
  guest.conn.clear();
  return { router, host, guest, code };
}

describe("Router: gameplay", () => {
  it("relays moves to everyone (including sender) with a seq", () => {
    const { host, guest } = table();
    host.send({ type: "move", payload: { to: "e4" } });
    expect(host.conn.ofType("ack")).toHaveLength(1);
    expect(host.conn.ofType("move")[0]).toMatchObject({ playerId: host.playerId, payload: { to: "e4" } });
    expect(guest.conn.ofType("move")[0]).toMatchObject({ payload: { to: "e4" } });
  });

  it("relays chat", () => {
    const { host, guest } = table();
    host.send({ type: "chat", text: "gg" });
    expect(guest.conn.ofType("chat")[0]).toMatchObject({ playerId: host.playerId, text: "gg" });
  });

  it("stamps strictly increasing unique seqs across message kinds", () => {
    const { host, guest } = table();
    host.send({ type: "move", payload: 1 });
    host.send({ type: "chat", text: "hi" });
    const seqs = guest.conn.sent.filter((m) => "seq" in m).map((m) => (m as { seq: number }).seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("rejects moves from players not in a room", () => {
    const router = new Router();
    const p = new FakePlayer(router);
    p.hello();
    p.send({ type: "move", payload: 1 });
    expect(p.conn.last()).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
  });

  it("dedupes a resent reqId without re-broadcasting", () => {
    const { router, host, guest } = table();
    const reqId = host.send({ type: "move", payload: 1 });
    router.handleMessage(host.conn, JSON.stringify({ type: "move", reqId, payload: 1 }));
    expect(guest.conn.ofType("move")).toHaveLength(1);
    expect(host.conn.ofType("ack")).toHaveLength(2);
  });

  it("stores snapshots and serves sync.request with snapshot + later broadcasts", () => {
    const { host, guest } = table();
    host.send({ type: "move", payload: 1 });
    const moveSeq = (host.conn.ofType("move")[0] as { seq: number }).seq;
    host.send({ type: "snapshot.set", seq: moveSeq, state: { board: "b1" } });
    host.send({ type: "move", payload: 2 });
    guest.conn.clear();
    guest.send({ type: "sync.request" });
    expect(guest.conn.ofType("snapshot")[0]).toMatchObject({ seq: moveSeq, state: { board: "b1" } });
    expect(guest.conn.ofType("move")).toHaveLength(1);
  });

  it("rejects snapshots ahead of the room seq", () => {
    const { host } = table();
    host.send({ type: "snapshot.set", seq: 99, state: {} });
    expect(host.conn.last()).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
  });

  it("sends snapshot and buffered broadcasts to a late joiner", () => {
    const { router, host, code } = table();
    host.send({ type: "move", payload: 1 });
    const moveSeq = (host.conn.ofType("move")[0] as { seq: number }).seq;
    host.send({ type: "snapshot.set", seq: moveSeq, state: { board: "b1" } });
    host.send({ type: "move", payload: 2 });
    const late = new FakePlayer(router);
    late.hello("Late");
    late.send({ type: "room.join", code });
    expect(late.conn.ofType("snapshot")[0]).toMatchObject({ seq: moveSeq });
    expect(late.conn.ofType("move")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/router-gameplay.test.ts`
Expected: FAIL — gameplay messages hit the `default:` branch ("unhandled message type").

- [ ] **Step 3: Add gameplay handling to `src/router.ts`**

Replace the switch's `default:` block region so the switch reads:

```ts
    switch (msg.type) {
      case "room.create":
        this.onRoomCreate(conn, session, msg, reply);
        break;
      case "room.join":
        this.onRoomJoin(conn, session, msg, reply);
        break;
      case "room.leave":
        this.onRoomLeave(session, msg, reply);
        break;
      case "move":
        this.onMove(session, msg, reply);
        break;
      case "chat":
        this.onChat(session, msg, reply);
        break;
      case "snapshot.set":
        this.onSnapshotSet(session, msg, reply);
        break;
      case "sync.request":
        this.onSyncRequest(conn, session, msg, reply);
        break;
      default:
        reply({ type: "error", reqId: msg.reqId, code: "INVALID_MESSAGE", message: "unhandled message type" });
    }
```

Then add these private methods to the `Router` class:

```ts
  private requireRoom(session: Session): Room | null {
    if (!session.roomCode) return null;
    return this.rooms.get(session.roomCode) ?? null;
  }

  private onMove(session: Session, msg: Msg<"move">, reply: Reply): void {
    const room = this.requireRoom(session);
    if (!room) {
      reply({ type: "error", reqId: msg.reqId, code: "INVALID_MESSAGE", message: "not in a room" });
      return;
    }
    reply({ type: "ack", reqId: msg.reqId });
    this.broadcast(room, { type: "move", seq: room.nextSeq(), playerId: session.playerId, payload: msg.payload });
  }

  private onChat(session: Session, msg: Msg<"chat">, reply: Reply): void {
    const room = this.requireRoom(session);
    if (!room) {
      reply({ type: "error", reqId: msg.reqId, code: "INVALID_MESSAGE", message: "not in a room" });
      return;
    }
    reply({ type: "ack", reqId: msg.reqId });
    this.broadcast(room, { type: "chat", seq: room.nextSeq(), playerId: session.playerId, text: msg.text });
  }

  private onSnapshotSet(session: Session, msg: Msg<"snapshot.set">, reply: Reply): void {
    const room = this.requireRoom(session);
    if (!room) {
      reply({ type: "error", reqId: msg.reqId, code: "INVALID_MESSAGE", message: "not in a room" });
      return;
    }
    if (msg.seq > room.seq) {
      reply({ type: "error", reqId: msg.reqId, code: "INVALID_MESSAGE", message: "snapshot seq is ahead of room seq" });
      return;
    }
    room.setSnapshot(msg.state, msg.seq);
    reply({ type: "ack", reqId: msg.reqId });
  }

  private onSyncRequest(conn: Connection, session: Session, msg: Msg<"sync.request">, reply: Reply): void {
    const room = this.requireRoom(session);
    if (!room) {
      reply({ type: "error", reqId: msg.reqId, code: "INVALID_MESSAGE", message: "not in a room" });
      return;
    }
    reply({ type: "ack", reqId: msg.reqId });
    for (const m of room.catchUp()) conn.send(m);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/router-gameplay.test.ts tests/router-rooms.test.ts`
Expected: PASS (both files — room tests must not regress).

- [ ] **Step 5: Commit**

```bash
git add src/router.ts tests/router-gameplay.test.ts
git commit -m "feat: move/chat relay, snapshots, sync.request, and reqId dedupe"
```

---

### Task 8: Router — disconnect, reconnect, host controls, TTL

**Files:**
- Modify: `src/router.ts` (add `handleClose` + lock/kick handlers + switch cases)
- Test: `tests/router-lifecycle.test.ts`

- [ ] **Step 1: Write the failing tests** — `tests/router-lifecycle.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "../src/router.js";
import { FakePlayer } from "./helpers/fake.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function table(router = new Router()) {
  const host = new FakePlayer(router);
  host.hello("Hosty");
  host.send({ type: "room.create" });
  const code = (host.conn.ofType("room.created")[0] as { code: string }).code;
  const guest = new FakePlayer(router);
  guest.hello("Guest");
  guest.send({ type: "room.join", code });
  host.conn.clear();
  guest.conn.clear();
  return { router, host, guest, code };
}

describe("Router: disconnect and reconnect", () => {
  it("marks a dropped player disconnected and broadcasts presence", () => {
    const { router, host, guest } = table();
    router.handleClose(guest.conn);
    expect(host.conn.ofType("presence")[0]).toMatchObject({
      event: "disconnect",
      playerId: guest.playerId,
    });
  });

  it("reseats a player who reconnects within the grace window", () => {
    const { router, host, guest } = table();
    router.handleClose(guest.conn);
    const back = new FakePlayer(router);
    back.hello("Guest", guest.token);
    expect(back.conn.ofType("room.joined")[0]).toMatchObject({ you: guest.playerId });
    expect(host.conn.ofType("presence").at(-1)).toMatchObject({
      event: "reconnect",
      playerId: guest.playerId,
    });
  });

  it("removes the player after the grace window expires", () => {
    const { router, host, guest } = table();
    router.handleClose(guest.conn);
    vi.advanceTimersByTime(120_001);
    expect(host.conn.ofType("presence").at(-1)).toMatchObject({
      event: "leave",
      playerId: guest.playerId,
    });
  });

  it("closes an abandoned room after the TTL even within the grace window", () => {
    const router = new Router({ reconnectGraceMs: 1_000_000_000, roomTtlMs: 1000 });
    const { host, guest, code } = table(router);
    router.handleClose(guest.conn);
    router.handleClose(host.conn);
    vi.advanceTimersByTime(1001);
    const probe = new FakePlayer(router);
    probe.hello();
    probe.send({ type: "room.join", code });
    expect(probe.conn.last()).toMatchObject({ type: "error", code: "ROOM_NOT_FOUND" });
  });

  it("does not close the room if someone reconnects before the TTL", () => {
    const router = new Router({ roomTtlMs: 1000 });
    const { host, guest, code } = table(router);
    router.handleClose(guest.conn);
    router.handleClose(host.conn);
    vi.advanceTimersByTime(500);
    const back = new FakePlayer(router);
    back.hello("Hosty", host.token);
    vi.advanceTimersByTime(600);
    expect(back.conn.ofType("room.joined")[0]).toMatchObject({ code });
    const probe = new FakePlayer(router);
    probe.hello();
    probe.send({ type: "room.join", code });
    expect(probe.conn.ofType("room.joined")).toHaveLength(1);
  });
});

describe("Router: host controls", () => {
  it("locks the room and rejects new joiners", () => {
    const { router, host, guest, code } = table();
    host.send({ type: "room.lock" });
    expect(guest.conn.ofType("room.locked")).toHaveLength(1);
    const probe = new FakePlayer(router);
    probe.hello();
    probe.send({ type: "room.join", code });
    expect(probe.conn.last()).toMatchObject({ type: "error", code: "ROOM_LOCKED" });
  });

  it("rejects lock from a non-host", () => {
    const { guest } = table();
    guest.send({ type: "room.lock" });
    expect(guest.conn.last()).toMatchObject({ type: "error", code: "NOT_HOST" });
  });

  it("unlocks the room", () => {
    const { router, host, code } = table();
    host.send({ type: "room.lock" });
    host.send({ type: "room.unlock" });
    const probe = new FakePlayer(router);
    probe.hello();
    probe.send({ type: "room.join", code });
    expect(probe.conn.ofType("room.joined")).toHaveLength(1);
  });

  it("kicks a player, who is notified and removed", () => {
    const { host, guest } = table();
    host.send({ type: "room.kick", playerId: guest.playerId });
    expect(guest.conn.ofType("presence").at(-1)).toMatchObject({
      event: "kick",
      playerId: guest.playerId,
    });
    guest.send({ type: "move", payload: 1 });
    expect(guest.conn.last()).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
  });

  it("rejects kick from a non-host", () => {
    const { host, guest } = table();
    guest.send({ type: "room.kick", playerId: host.playerId });
    expect(guest.conn.last()).toMatchObject({ type: "error", code: "NOT_HOST" });
  });

  it("host cannot kick themselves", () => {
    const { host } = table();
    host.send({ type: "room.kick", playerId: host.playerId });
    expect(host.conn.last()).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/router-lifecycle.test.ts`
Expected: FAIL — `handleClose` does not exist; lock/kick hit the `default:` branch.

- [ ] **Step 3: Add lifecycle handling to `src/router.ts`**

Add these cases to the switch (before `default:`):

```ts
      case "room.lock":
        this.onSetLock(session, msg, reply, true);
        break;
      case "room.unlock":
        this.onSetLock(session, msg, reply, false);
        break;
      case "room.kick":
        this.onRoomKick(session, msg, reply);
        break;
```

Add the public `handleClose` method and the private handlers:

```ts
  handleClose(conn: Connection): void {
    const session = this.bySession.get(conn);
    if (!session) return;
    this.bySession.delete(conn);
    if (this.connOf.get(session.playerId) === conn) this.connOf.delete(session.playerId);
    session.connected = false;
    if (!session.roomCode) return;
    const room = this.rooms.get(session.roomCode);
    const member = room?.members.get(session.playerId);
    if (!room || !member) return;
    member.connected = false;
    this.broadcast(room, {
      type: "presence",
      seq: room.nextSeq(),
      event: "disconnect",
      playerId: session.playerId,
      nickname: session.nickname,
    });
    this.events.playerDisconnected?.(room.code, session.playerId);
    const code = room.code;
    this.graceTimers.set(
      session.playerId,
      setTimeout(() => {
        this.graceTimers.delete(session.playerId);
        if (session.roomCode === code && !session.connected) this.removeFromRoom(session, "leave");
      }, this.opts.reconnectGraceMs),
    );
    this.checkEmpty(room);
  }

  private onSetLock(session: Session, msg: Msg<"room.lock"> | Msg<"room.unlock">, reply: Reply, locked: boolean): void {
    const room = this.requireRoom(session);
    if (!room) {
      reply({ type: "error", reqId: msg.reqId, code: "INVALID_MESSAGE", message: "not in a room" });
      return;
    }
    if (room.hostId !== session.playerId) {
      reply({ type: "error", reqId: msg.reqId, code: "NOT_HOST", message: "only the host can do that" });
      return;
    }
    room.locked = locked;
    reply({ type: "ack", reqId: msg.reqId });
    this.broadcast(
      room,
      locked
        ? { type: "room.locked", seq: room.nextSeq(), playerId: session.playerId }
        : { type: "room.unlocked", seq: room.nextSeq(), playerId: session.playerId },
    );
  }

  private onRoomKick(session: Session, msg: Msg<"room.kick">, reply: Reply): void {
    const room = this.requireRoom(session);
    if (!room) {
      reply({ type: "error", reqId: msg.reqId, code: "INVALID_MESSAGE", message: "not in a room" });
      return;
    }
    if (room.hostId !== session.playerId) {
      reply({ type: "error", reqId: msg.reqId, code: "NOT_HOST", message: "only the host can do that" });
      return;
    }
    if (msg.playerId === session.playerId) {
      reply({ type: "error", reqId: msg.reqId, code: "INVALID_MESSAGE", message: "cannot kick yourself" });
      return;
    }
    const target = this.sessions.get(msg.playerId);
    if (!target || !room.members.has(msg.playerId)) {
      reply({ type: "error", reqId: msg.reqId, code: "INVALID_MESSAGE", message: "player not in room" });
      return;
    }
    const targetConn = this.connOf.get(msg.playerId);
    const presence = this.removeFromRoom(target, "kick");
    if (presence && targetConn) targetConn.send(presence);
    reply({ type: "ack", reqId: msg.reqId });
  }
```

- [ ] **Step 4: Run all router tests to verify they pass**

Run: `npx vitest run tests/router-lifecycle.test.ts tests/router-gameplay.test.ts tests/router-rooms.test.ts`
Expected: PASS (all three files).

- [ ] **Step 5: Commit**

```bash
git add src/router.ts tests/router-lifecycle.test.ts
git commit -m "feat: reconnect grace window, room TTL, lock/unlock, and kick"
```

---

### Task 9: GameServer over real sockets

**Files:**
- Create: `src/server.ts`, `tests/helpers/client.ts`
- Test: `tests/server.test.ts`

- [ ] **Step 1: Write the integration test client** — `tests/helpers/client.ts`

```ts
import WebSocket from "ws";
import type { ServerMessage } from "../../src/types.js";

type Waiter = { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void };

export class TestClient {
  private inbox: ServerMessage[] = [];
  private waiters: Waiter[] = [];
  private reqId = 0;

  static async connect(port: number): Promise<TestClient> {
    const client = new TestClient(new WebSocket(`ws://127.0.0.1:${port}`));
    await new Promise<void>((resolve, reject) => {
      client.ws.once("open", () => resolve());
      client.ws.once("error", reject);
    });
    return client;
  }

  constructor(private ws: WebSocket) {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      const i = this.waiters.findIndex((w) => w.match(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
      else this.inbox.push(msg);
    });
  }

  send(partial: Record<string, unknown>): number {
    const reqId = ++this.reqId;
    this.ws.send(JSON.stringify({ ...partial, reqId }));
    return reqId;
  }

  next<T extends ServerMessage["type"]>(type: T, timeoutMs = 2000): Promise<Extract<ServerMessage, { type: T }>> {
    const match = (m: ServerMessage) => m.type === type;
    const i = this.inbox.findIndex(match);
    if (i >= 0) {
      return Promise.resolve(this.inbox.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }

  onPing(cb: () => void): void {
    this.ws.on("ping", cb);
  }

  close(): void {
    this.ws.close();
  }

  terminate(): void {
    this.ws.terminate();
  }
}
```

- [ ] **Step 2: Write the failing tests** — `tests/server.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GameServer } from "../src/server.js";
import { TestClient } from "./helpers/client.js";

describe("GameServer integration", () => {
  let server: GameServer;
  let port: number;

  beforeEach(async () => {
    server = new GameServer({ reconnectGraceMs: 500, roomTtlMs: 1000, heartbeatIntervalMs: 100 });
    port = await server.listen(0);
  });

  afterEach(async () => {
    await server.close();
  });

  it("plays a full story: create, join, move, snapshot, reconnect", async () => {
    const alice = await TestClient.connect(port);
    alice.send({ type: "hello", nickname: "Alice" });
    await alice.next("welcome");
    alice.send({ type: "room.create" });
    const created = await alice.next("room.created");

    const bob = await TestClient.connect(port);
    bob.send({ type: "hello", nickname: "Bob" });
    const bobWelcome = await bob.next("welcome");
    bob.send({ type: "room.join", code: created.code });
    const joined = await bob.next("room.joined");
    expect(joined.members).toHaveLength(2);
    await alice.next("presence"); // Bob joined

    alice.send({ type: "move", payload: { piece: "pawn", to: "e4" } });
    const moveAtAlice = await alice.next("move");
    const moveAtBob = await bob.next("move");
    expect(moveAtBob.seq).toBe(moveAtAlice.seq);
    expect(moveAtBob.payload).toEqual({ piece: "pawn", to: "e4" });

    alice.send({ type: "snapshot.set", seq: moveAtAlice.seq, state: { board: "after-e4" } });
    await alice.next("ack");

    bob.terminate();
    await alice.next("presence"); // Bob disconnected

    const bob2 = await TestClient.connect(port);
    bob2.send({ type: "hello", token: bobWelcome.token });
    await bob2.next("welcome");
    const rejoined = await bob2.next("room.joined");
    expect(rejoined.you).toBe(bobWelcome.playerId);
    const snap = await bob2.next("snapshot");
    expect(snap.state).toEqual({ board: "after-e4" });
    await alice.next("presence"); // Bob reconnected
  });

  it("sends heartbeat pings", async () => {
    const c = await TestClient.connect(port);
    await new Promise<void>((resolve) => c.onPing(resolve));
    c.close();
  });

  it("rate limits a flooding client", async () => {
    const c = await TestClient.connect(port);
    c.send({ type: "hello" });
    await c.next("welcome");
    c.send({ type: "room.create" });
    await c.next("room.created");
    for (let i = 0; i < 30; i++) c.send({ type: "chat", text: "spam" });
    const err = await c.next("error");
    expect(err.code).toBe("RATE_LIMITED");
    c.close();
  });

  it("emits lifecycle events", async () => {
    const events: string[] = [];
    server.on("roomCreated", (code: string) => events.push(`created:${code}`));
    const c = await TestClient.connect(port);
    c.send({ type: "hello" });
    await c.next("welcome");
    c.send({ type: "room.create" });
    const created = await c.next("room.created");
    expect(events).toEqual([`created:${created.code}`]);
    c.close();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — cannot resolve `../src/server.js`.

- [ ] **Step 4: Write `src/server.ts`**

```ts
import { EventEmitter } from "node:events";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { Router, type Connection } from "./router.js";
import type { ServerMessage } from "./types.js";

export interface GameServerOptions {
  maxPlayersPerRoom?: number;
  reconnectGraceMs?: number;
  roomTtlMs?: number;
  heartbeatIntervalMs?: number;
  rateLimitPerSec?: number;
}

const MAX_INVALID_MESSAGES = 10;

interface Tracked {
  ws: WebSocket;
  conn: Connection;
  missedPings: number;
  msgCount: number;
  windowStart: number;
  invalidCount: number;
}

export class GameServer extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private router: Router;
  private heartbeat: NodeJS.Timeout | null = null;
  private clients = new Set<Tracked>();
  private heartbeatIntervalMs: number;
  private rateLimitPerSec: number;

  constructor(options: GameServerOptions = {}) {
    super();
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.rateLimitPerSec = options.rateLimitPerSec ?? 20;
    this.router = new Router(
      {
        maxPlayersPerRoom: options.maxPlayersPerRoom,
        reconnectGraceMs: options.reconnectGraceMs,
        roomTtlMs: options.roomTtlMs,
      },
      {
        roomCreated: (code) => this.emit("roomCreated", code),
        roomClosed: (code) => this.emit("roomClosed", code),
        playerJoined: (code, playerId) => this.emit("playerJoined", code, playerId),
        playerLeft: (code, playerId) => this.emit("playerLeft", code, playerId),
        playerDisconnected: (code, playerId) => this.emit("playerDisconnected", code, playerId),
        playerReconnected: (code, playerId) => this.emit("playerReconnected", code, playerId),
      },
    );
  }

  listen(port: number): Promise<number> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port, maxPayload: 256 * 1024 });
      this.setup(this.wss);
      this.wss.on("listening", () => {
        const addr = this.wss!.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : port);
      });
    });
  }

  attach(server: HttpServer): void {
    this.wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });
    this.setup(this.wss);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      for (const t of this.clients) t.ws.terminate();
      this.router.dispose();
      if (this.wss) this.wss.close(() => resolve());
      else resolve();
    });
  }

  private setup(wss: WebSocketServer): void {
    wss.on("connection", (ws) => {
      const conn: Connection = {
        send: (msg: ServerMessage) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
        },
        close: () => ws.close(),
      };
      const tracked: Tracked = {
        ws,
        conn,
        missedPings: 0,
        msgCount: 0,
        windowStart: Date.now(),
        invalidCount: 0,
      };
      this.clients.add(tracked);
      ws.on("pong", () => {
        tracked.missedPings = 0;
      });
      ws.on("message", (data) => {
        const now = Date.now();
        if (now - tracked.windowStart >= 1000) {
          tracked.windowStart = now;
          tracked.msgCount = 0;
        }
        tracked.msgCount++;
        if (tracked.msgCount > this.rateLimitPerSec) {
          conn.send({ type: "error", reqId: null, code: "RATE_LIMITED", message: "too many messages" });
          return;
        }
        const valid = this.router.handleMessage(conn, data.toString());
        if (!valid && ++tracked.invalidCount >= MAX_INVALID_MESSAGES) ws.close();
      });
      ws.on("close", () => {
        this.clients.delete(tracked);
        this.router.handleClose(conn);
      });
    });
    this.heartbeat = setInterval(() => {
      for (const t of this.clients) {
        if (t.missedPings >= 2) {
          t.ws.terminate();
          continue;
        }
        t.missedPings++;
        t.ws.ping();
      }
    }, this.heartbeatIntervalMs);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS (all four tests).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — every test file.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts tests/helpers/client.ts tests/server.test.ts
git commit -m "feat: GameServer with ws wiring, heartbeat, rate limit, and events"
```

---

### Task 10: Public exports, PROTOCOL.md, README

**Files:**
- Create: `src/index.ts`, `PROTOCOL.md`, `README.md`

- [ ] **Step 1: Write `src/index.ts`**

```ts
export { GameServer, type GameServerOptions } from "./server.js";
export type { Connection, RouterEvents, RouterOptions } from "./router.js";
export type {
  ClientMessage,
  ErrorCode,
  MemberInfo,
  PresenceEvent,
  ServerMessage,
} from "./types.js";
```

- [ ] **Step 2: Write `PROTOCOL.md`**

```markdown
# boardgame-ws Wire Protocol v0.1

All messages are JSON objects sent as WebSocket text frames.

## Envelope

Client → server messages carry a client-chosen `reqId` (positive integer,
strictly increasing per connection/session). The server answers every request
with either `{"type":"ack","reqId":N}` or
`{"type":"error","reqId":N,"code":"...","message":"..."}`.

If you resend a request with a `reqId` the server has already processed, it
re-sends the previous ack/error and does **not** apply the request again —
safe retry after a network hiccup.

Server → room broadcasts carry a per-room strictly increasing `seq`. If you
observe a gap in `seq`, send `sync.request` to recover.

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
| `hello` | `token?`, `nickname?` (≤32 chars) | Must be first message |
| `room.create` | — | Creator becomes host |
| `room.join` | `code` (6 chars, case-insensitive) | |
| `room.leave` | — | |
| `move` | `payload` (any JSON) | Relayed verbatim, never interpreted |
| `chat` | `text` (1–2000 chars) | |
| `snapshot.set` | `seq`, `state` (any JSON) | `seq` = last seq reflected in `state` |
| `sync.request` | — | Re-sends snapshot + newer broadcasts |
| `room.lock` / `room.unlock` | — | Host only |
| `room.kick` | `playerId` | Host only |

Size caps: 64KB per message, 256KB for `snapshot.set`.
Rate limit: 20 messages/second per connection.

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
```

- [ ] **Step 3: Write `README.md`**

````markdown
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
````

- [ ] **Step 4: Full verification**

Run: `npm test`
Expected: PASS — all test files.
Run: `npm run typecheck`
Expected: exit 0.
Run: `npm run build`
Expected: exit 0; `dist/index.js` and `dist/index.d.ts` exist.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts PROTOCOL.md README.md
git commit -m "docs: wire protocol spec, README, and public exports"
```

---

## Spec coverage notes

- Every spec requirement maps to a task: rooms/codes (5, 6), ordered relay +
  dedupe (7), snapshots + broadcast buffer + sync.request (5, 7), identity +
  reconnect grace (4, 6, 8), presence (6, 8), host controls (8), TTL (8),
  heartbeat/rate limit/size caps/invalid-message disconnect (2, 9),
  observability events (6, 9), PROTOCOL.md (10).
- Heartbeat *termination* (2 missed pongs) is implemented but not
  integration-tested — standard `ws` clients pong automatically, making the
  negative case impractical to test cheaply. Accepted for MVP.
- `attach(httpServer)` is implemented but only `listen()` is exercised by
  tests. Accepted for MVP.
```
