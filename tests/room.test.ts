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
