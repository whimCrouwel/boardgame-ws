import type { Connection, Router } from "../../src/router.js";
import type { ServerMessage } from "../../src/types.js";

export class FakeConnection implements Connection {
  sent: ServerMessage[] = [];
  closed = false;

  send(msg: ServerMessage): void {
    this.sent.push(msg);
  }

  close(): void {
    this.closed = true;
  }

  last(): ServerMessage {
    return this.sent[this.sent.length - 1];
  }

  ofType(type: ServerMessage["type"]): ServerMessage[] {
    return this.sent.filter((m) => m.type === type);
  }

  clear(): void {
    this.sent = [];
  }
}

export class FakePlayer {
  conn = new FakeConnection();
  playerId = "";
  token = "";
  private reqId = 0;

  constructor(private router: Router) {}

  send(partial: Record<string, unknown>): number {
    const reqId = ++this.reqId;
    this.router.handleMessage(this.conn, JSON.stringify({ ...partial, reqId }));
    return reqId;
  }

  hello(nickname = "Player", token?: string): void {
    this.send(token === undefined ? { type: "hello", nickname } : { type: "hello", nickname, token });
    const welcome = this.conn.sent.filter((m) => m.type === "welcome").at(-1) as
      | Extract<ServerMessage, { type: "welcome" }>
      | undefined;
    if (welcome) {
      this.playerId = welcome.playerId;
      this.token = welcome.token;
    }
  }
}
