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
