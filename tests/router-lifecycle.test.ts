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

  it("dedupe survives reconnect: stale reqIds replay the cached response", () => {
    const { router, host, guest } = table();
    guest.send({ type: "move", payload: 1 });
    router.handleClose(guest.conn);
    const back = new FakePlayer(router);
    back.hello("Guest", guest.token);
    back.conn.clear();
    // reqId 1 was already used by the original hello; the session's counter
    // is higher, so a stale reqId must be swallowed and must not broadcast
    router.handleMessage(back.conn, JSON.stringify({ type: "move", reqId: 1, payload: "stale" }));
    expect(back.conn.ofType("move")).toHaveLength(0);
    expect(host.conn.ofType("move")).toHaveLength(1);
  });

  it("a live takeover closes the old connection and reseats the player", () => {
    const { router, host, guest } = table();
    const taker = new FakePlayer(router);
    taker.hello("Guest", guest.token);
    expect(guest.conn.closed).toBe(true);
    expect(taker.conn.ofType("room.joined")[0]).toMatchObject({ you: guest.playerId });
    // no disconnect/reconnect presence was broadcast for a live takeover
    expect(host.conn.ofType("presence")).toHaveLength(0);
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
