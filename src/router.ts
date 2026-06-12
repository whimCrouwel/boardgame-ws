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
