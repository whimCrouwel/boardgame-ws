import type { ClientMessage } from "./types.js";

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024;

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; reqId: number | null; error: string };

function fail(reqId: number | null, error: string): ParseResult {
  return { ok: false, reqId, error };
}

export function parseClientMessage(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fail(null, "invalid JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return fail(null, "message must be an object");
  }
  const msg = data as Record<string, unknown>;
  const reqId =
    typeof msg.reqId === "number" && Number.isInteger(msg.reqId) && msg.reqId > 0 ? msg.reqId : null;
  if (reqId === null) return fail(null, "reqId must be a positive integer");
  if (typeof msg.type !== "string") return fail(reqId, "type must be a string");

  const cap = msg.type === "snapshot.set" ? MAX_SNAPSHOT_BYTES : MAX_MESSAGE_BYTES;
  if (Buffer.byteLength(raw) > cap) return fail(reqId, `message exceeds ${cap} byte limit`);

  switch (msg.type) {
    case "hello":
      if (msg.token !== undefined && typeof msg.token !== "string") {
        return fail(reqId, "token must be a string");
      }
      if (
        msg.nickname !== undefined &&
        (typeof msg.nickname !== "string" || msg.nickname.length === 0 || msg.nickname.length > 32)
      ) {
        return fail(reqId, "nickname must be a non-empty string of at most 32 chars");
      }
      return {
        ok: true,
        message: {
          type: "hello",
          reqId,
          token: msg.token as string | undefined,
          nickname: msg.nickname as string | undefined,
        },
      };
    case "room.create":
    case "room.leave":
    case "room.lock":
    case "room.unlock":
    case "sync.request":
      return { ok: true, message: { type: msg.type, reqId } };
    case "room.join":
      if (typeof msg.code !== "string" || msg.code.length !== 6) {
        return fail(reqId, "code must be a 6-character string");
      }
      return { ok: true, message: { type: "room.join", reqId, code: msg.code } };
    case "move":
      if (!("payload" in msg)) return fail(reqId, "payload is required");
      return { ok: true, message: { type: "move", reqId, payload: msg.payload } };
    case "chat":
      if (typeof msg.text !== "string" || msg.text.length === 0 || msg.text.length > 2000) {
        return fail(reqId, "text must be a string of 1-2000 chars");
      }
      return { ok: true, message: { type: "chat", reqId, text: msg.text } };
    case "snapshot.set":
      if (typeof msg.seq !== "number" || !Number.isInteger(msg.seq) || msg.seq < 0) {
        return fail(reqId, "seq must be a non-negative integer");
      }
      if (!("state" in msg)) return fail(reqId, "state is required");
      return { ok: true, message: { type: "snapshot.set", reqId, seq: msg.seq, state: msg.state } };
    case "room.kick":
      if (typeof msg.playerId !== "string" || msg.playerId.length === 0)
        return fail(reqId, "playerId must be a non-empty string");
      return { ok: true, message: { type: "room.kick", reqId, playerId: msg.playerId } };
    default:
      return fail(reqId, `unknown message type: ${msg.type}`);
  }
}
