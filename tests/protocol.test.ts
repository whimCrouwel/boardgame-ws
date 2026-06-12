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

  it("rejects an empty kick playerId", () => {
    expect(parseClientMessage(JSON.stringify({ type: "room.kick", reqId: 4, playerId: "" })).ok).toBe(false);
  });

  it("rejects an empty hello nickname", () => {
    expect(parseClientMessage(JSON.stringify({ type: "hello", reqId: 1, nickname: "" })).ok).toBe(false);
  });
});
