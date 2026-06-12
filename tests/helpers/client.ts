import WebSocket from "ws";
import type { ServerMessage } from "../../src/types.js";

type Waiter = { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void };

export class TestClient {
  private inbox: ServerMessage[] = [];
  private waiters: Waiter[] = [];
  private reqId = 0;

  static async connect(port: number): Promise<TestClient> {
    const client = new TestClient(new WebSocket(`ws://127.0.0.1:${port}`));
    await new Promise<void>((resolve, reject) => {
      client.ws.once("open", () => resolve());
      client.ws.once("error", reject);
    });
    return client;
  }

  constructor(private ws: WebSocket) {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      const i = this.waiters.findIndex((w) => w.match(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
      else this.inbox.push(msg);
    });
  }

  send(partial: Record<string, unknown>): number {
    const reqId = ++this.reqId;
    this.ws.send(JSON.stringify({ ...partial, reqId }));
    return reqId;
  }

  next<T extends ServerMessage["type"]>(type: T, timeoutMs = 2000): Promise<Extract<ServerMessage, { type: T }>> {
    const match = (m: ServerMessage) => m.type === type;
    const i = this.inbox.findIndex(match);
    if (i >= 0) {
      return Promise.resolve(this.inbox.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }

  onPing(cb: () => void): void {
    this.ws.on("ping", cb);
  }

  sendRaw(data: string): void {
    this.ws.send(data);
  }

  onClose(cb: () => void): void {
    this.ws.on("close", cb);
  }

  close(): void {
    this.ws.close();
  }

  terminate(): void {
    this.ws.terminate();
  }
}
