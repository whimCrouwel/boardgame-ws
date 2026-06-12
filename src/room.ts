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
