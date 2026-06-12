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
