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
