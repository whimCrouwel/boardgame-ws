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
