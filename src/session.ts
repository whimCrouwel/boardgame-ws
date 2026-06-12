import { randomBytes } from "node:crypto";
import type { ServerMessage } from "./types.js";

export interface Session {
  playerId: string;
  token: string;
  nickname: string;
  roomCode: string | null;
  lastReqId: number;
  lastResponse: ServerMessage | null;
  connected: boolean;
}

export class SessionManager {
  private byToken = new Map<string, Session>();
  private byId = new Map<string, Session>();

  create(nickname: string): Session {
    const session: Session = {
      playerId: `p_${randomBytes(4).toString("hex")}`,
      token: randomBytes(16).toString("hex"),
      nickname,
      roomCode: null,
      lastReqId: 0,
      lastResponse: null,
      connected: false,
    };
    this.byToken.set(session.token, session);
    this.byId.set(session.playerId, session);
    return session;
  }

  resume(token: string): Session | undefined {
    return this.byToken.get(token);
  }

  get(playerId: string): Session | undefined {
    return this.byId.get(playerId);
  }
}
