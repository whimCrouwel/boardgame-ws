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
