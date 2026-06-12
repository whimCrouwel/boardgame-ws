import { EventEmitter } from "node:events";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { Router, type Connection } from "./router.js";
import type { ServerMessage } from "./types.js";

export interface GameServerOptions {
  maxPlayersPerRoom?: number;
  reconnectGraceMs?: number;
  roomTtlMs?: number;
  heartbeatIntervalMs?: number;
  rateLimitPerSec?: number;
}

const MAX_INVALID_MESSAGES = 10;

interface Tracked {
  ws: WebSocket;
  conn: Connection;
  missedPings: number;
  msgCount: number;
  windowStart: number;
  invalidCount: number;
}

export class GameServer extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private router: Router;
  private heartbeat: NodeJS.Timeout | null = null;
  private clients = new Set<Tracked>();
  private heartbeatIntervalMs: number;
  private rateLimitPerSec: number;

  constructor(options: GameServerOptions = {}) {
    super();
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.rateLimitPerSec = options.rateLimitPerSec ?? 20;
    this.router = new Router(
      {
        maxPlayersPerRoom: options.maxPlayersPerRoom,
        reconnectGraceMs: options.reconnectGraceMs,
        roomTtlMs: options.roomTtlMs,
      },
      {
        roomCreated: (code) => this.emit("roomCreated", code),
        roomClosed: (code) => this.emit("roomClosed", code),
        playerJoined: (code, playerId) => this.emit("playerJoined", code, playerId),
        playerLeft: (code, playerId) => this.emit("playerLeft", code, playerId),
        playerDisconnected: (code, playerId) => this.emit("playerDisconnected", code, playerId),
        playerReconnected: (code, playerId) => this.emit("playerReconnected", code, playerId),
      },
    );
  }

  listen(port: number): Promise<number> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port, maxPayload: 256 * 1024 });
      this.setup(this.wss);
      this.wss.on("listening", () => {
        const addr = this.wss!.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : port);
      });
    });
  }

  attach(server: HttpServer): void {
    this.wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });
    this.setup(this.wss);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      for (const t of this.clients) t.ws.terminate();
      this.router.dispose();
      if (this.wss) this.wss.close(() => resolve());
      else resolve();
    });
  }

  private setup(wss: WebSocketServer): void {
    wss.on("connection", (ws) => {
      const conn: Connection = {
        send: (msg: ServerMessage) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
        },
        close: () => ws.close(),
      };
      const tracked: Tracked = {
        ws,
        conn,
        missedPings: 0,
        msgCount: 0,
        windowStart: Date.now(),
        invalidCount: 0,
      };
      this.clients.add(tracked);
      ws.on("pong", () => {
        tracked.missedPings = 0;
      });
      ws.on("message", (data) => {
        const now = Date.now();
        if (now - tracked.windowStart >= 1000) {
          tracked.windowStart = now;
          tracked.msgCount = 0;
        }
        tracked.msgCount++;
        if (tracked.msgCount > this.rateLimitPerSec) {
          conn.send({ type: "error", reqId: null, code: "RATE_LIMITED", message: "too many messages" });
          return;
        }
        const valid = this.router.handleMessage(conn, data.toString());
        if (!valid && ++tracked.invalidCount >= MAX_INVALID_MESSAGES) ws.close();
      });
      ws.on("close", () => {
        this.clients.delete(tracked);
        this.router.handleClose(conn);
      });
    });
    this.heartbeat = setInterval(() => {
      for (const t of this.clients) {
        if (t.missedPings >= 2) {
          t.ws.terminate();
          continue;
        }
        t.missedPings++;
        t.ws.ping();
      }
    }, this.heartbeatIntervalMs);
  }
}
