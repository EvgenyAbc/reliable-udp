import { Buffer } from "node:buffer";

export const CHANNEL_EVENT = 1;
export const CHANNEL_INPUT = 2;
/** Kept for ABI stability; ping-pong server no longer sends on this channel. */
export const CHANNEL_STATE = 3;
export const PING_PONG_PROTOCOL_VERSION = 2;
const MAGIC = 0xab;

export type PaddleInput = -1 | 0 | 1;
export type Side = "left" | "right";
export type RoomRole = "host" | "guest";
export type RoomPhase =
  | "open"
  | "full"
  | "starting"
  | "running"
  | "finishing"
  | "closed";
export type RoomVisibility = "public" | "private";
export interface RoomSummary {
  roomId: string;
  hostName: string;
  connected: number;
  running: boolean;
  phase?: RoomPhase;
  visibility?: RoomVisibility;
  roomVersion?: number;
}
export interface RoomStateSnapshot {
  roomId: string;
  hostName: string;
  guestName?: string;
  connected: number;
  running: boolean;
  phase: RoomPhase;
  visibility: RoomVisibility;
  roomVersion: number;
  leftScore: number;
  rightScore: number;
  startedAtMs?: number;
}

export type BallEventReason = "wallBounce" | "paddleHit" | "reset";

export interface BallState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface GameState {
  ball: BallState;
  leftY: number;
  rightY: number;
  leftScore: number;
  rightScore: number;
  running: boolean;
}

/** Bootstrap payload on game start (full state once). */
export interface TimedGameState {
  state: GameState;
  serverTimeMs: number;
  sequence: number;
}

export type ClientMessage =
  | {
      type: "createRoom";
      name: string;
      version: number;
      requestId?: string;
      visibility?: RoomVisibility;
    }
  | { type: "joinRoom"; roomId?: string; name: string; version: number; requestId?: string }
  | { type: "leaveRoom"; requestId?: string }
  | { type: "deleteRoom"; requestId?: string }
  | { type: "startRoom"; requestId?: string }
  | { type: "listRooms" }
  | { type: "quit"; requestId?: string }
  | { type: "heartbeat"; nowMs?: number; reconnectToken?: string }
  | { type: "reconnect"; reconnectToken: string; requestId?: string }
  | { type: "input"; input: PaddleInput };

export type ServerMessage =
  | {
      type: "roomCreated";
      roomId: string;
      role: RoomRole;
      side: Side;
      connected: number;
    }
  | {
      type: "roomJoined";
      roomId: string;
      role: RoomRole;
      side: Side;
      connected: number;
    }
  | { type: "roomWaiting"; roomId: string; connected: number }
  | { type: "roomLeft"; roomId: string }
  | { type: "roomDeleted"; roomId: string }
  | { type: "roomStarted"; roomId: string }
  | {
      type: "roomFinished";
      roomId: string;
      winner: Side;
      leftScore: number;
      rightScore: number;
    }
  | {
      type: "lobbyState";
      rooms: RoomSummary[];
      you: { roomId?: string; role?: RoomRole; side?: Side };
      lobbyVersion?: number;
    }
  | { type: "roomState"; state: RoomStateSnapshot }
  | { type: "roomError"; code: string; message: string }
  | { type: "playerAssigned"; side: Side }
  | {
      type: "gameStart";
      state: GameState;
      serverTimeMs: number;
      sequence: number;
    }
  | {
      type: "ballEvent";
      reason: BallEventReason;
      ball: BallState;
      leftScore: number;
      rightScore: number;
      serverTimeMs: number;
      sequence: number;
    }
  | {
      type: "inputEvent";
      side: Side;
      input: PaddleInput;
      serverTimeMs: number;
      sequence: number;
    }
  | {
      type: "versionMismatch";
      expectedVersion: number;
      actualVersion: number;
    }
  | { type: "reconnectAccepted"; roomId?: string };

const TAG = {
  createRoom: 1,
  joinRoom: 2,
  leaveRoom: 3,
  deleteRoom: 4,
  startRoom: 5,
  listRooms: 6,
  quit: 7,
  input: 8,
  heartbeat: 9,
  reconnect: 10,
  waiting: 101,
  full: 102,
  playerAssigned: 103,
  gameStart: 104,
  ballEvent: 105,
  inputEvent: 106,
  versionMismatch: 107,
} as const;

function isValidGameState(state: GameState): boolean {
  return (
    !!state &&
    typeof state === "object" &&
    typeof state.leftY === "number" &&
    typeof state.rightY === "number" &&
    typeof state.leftScore === "number" &&
    typeof state.rightScore === "number" &&
    typeof state.running === "boolean" &&
    !!state.ball &&
    typeof state.ball === "object" &&
    typeof state.ball.x === "number" &&
    typeof state.ball.y === "number" &&
    typeof state.ball.vx === "number" &&
    typeof state.ball.vy === "number"
  );
}

function isValidBallState(ball: BallState): boolean {
  return (
    !!ball &&
    typeof ball === "object" &&
    typeof ball.x === "number" &&
    typeof ball.y === "number" &&
    typeof ball.vx === "number" &&
    typeof ball.vy === "number"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function encodeMessage(message: ClientMessage | ServerMessage): Buffer {
  switch (message.type) {
    case "createRoom": {
      const name = Buffer.from(message.name, "utf8");
      const payload = Buffer.allocUnsafe(4 + 1 + name.length);
      payload[0] = MAGIC;
      payload[1] = PING_PONG_PROTOCOL_VERSION;
      payload[2] = TAG.createRoom;
      payload[3] = message.version & 0xff;
      payload[4] = name.length & 0xff;
      name.copy(payload, 5);
      return payload;
    }
    case "joinRoom": {
      const roomId = Buffer.from(message.roomId ?? "", "utf8");
      const name = Buffer.from(message.name, "utf8");
      const payload = Buffer.allocUnsafe(6 + roomId.length + name.length);
      let o = 0;
      payload[o++] = MAGIC;
      payload[o++] = PING_PONG_PROTOCOL_VERSION;
      payload[o++] = TAG.joinRoom;
      payload[o++] = message.version & 0xff;
      payload[o++] = roomId.length & 0xff;
      roomId.copy(payload, o);
      o += roomId.length;
      payload[o++] = name.length & 0xff;
      name.copy(payload, o);
      return payload;
    }
    case "leaveRoom":
      return Buffer.from([MAGIC, PING_PONG_PROTOCOL_VERSION, TAG.leaveRoom]);
    case "deleteRoom":
      return Buffer.from([MAGIC, PING_PONG_PROTOCOL_VERSION, TAG.deleteRoom]);
    case "startRoom":
      return Buffer.from([MAGIC, PING_PONG_PROTOCOL_VERSION, TAG.startRoom]);
    case "listRooms":
      return Buffer.from([MAGIC, PING_PONG_PROTOCOL_VERSION, TAG.listRooms]);
    case "quit":
      return Buffer.from([MAGIC, PING_PONG_PROTOCOL_VERSION, TAG.quit]);
    case "input": {
      return Buffer.from([
        MAGIC,
        PING_PONG_PROTOCOL_VERSION,
        TAG.input,
        (message.input + 1) & 0xff,
      ]);
    }
    case "ballEvent": {
      const buf = Buffer.allocUnsafe(36);
      let o = 0;
      buf[o++] = MAGIC;
      buf[o++] = PING_PONG_PROTOCOL_VERSION;
      buf[o++] = TAG.ballEvent;
      const reason =
        message.reason === "wallBounce" ? 0 : message.reason === "paddleHit" ? 1 : 2;
      buf[o++] = reason;
      buf.writeFloatLE(message.ball.x, o);
      o += 4;
      buf.writeFloatLE(message.ball.y, o);
      o += 4;
      buf.writeFloatLE(message.ball.vx, o);
      o += 4;
      buf.writeFloatLE(message.ball.vy, o);
      o += 4;
      buf.writeInt16LE(message.leftScore, o);
      o += 2;
      buf.writeInt16LE(message.rightScore, o);
      o += 2;
      buf.writeDoubleLE(message.serverTimeMs, o);
      o += 8;
      buf.writeUInt32LE(message.sequence >>> 0, o);
      return buf;
    }
    case "inputEvent": {
      const buf = Buffer.allocUnsafe(17);
      let o = 0;
      buf[o++] = MAGIC;
      buf[o++] = PING_PONG_PROTOCOL_VERSION;
      buf[o++] = TAG.inputEvent;
      buf[o++] = message.side === "left" ? 0 : 1;
      buf[o++] = (message.input + 1) & 0xff;
      buf.writeDoubleLE(message.serverTimeMs, o);
      o += 8;
      buf.writeUInt32LE(message.sequence >>> 0, o);
      return buf;
    }
    default:
      return Buffer.from(
        JSON.stringify({
          ...message,
          _protocolVersion: PING_PONG_PROTOCOL_VERSION,
        }),
        "utf8",
      );
  }
}

export function decodeClientMessage(data: Buffer): ClientMessage | null {
  if (data.length >= 3 && data[0] === MAGIC) {
    if (data[1] !== PING_PONG_PROTOCOL_VERSION) return null;
    const tag = data[2];
    if (tag === TAG.createRoom && data.length >= 5) {
      const version = data[3] ?? 0;
      const len = data[4] ?? 0;
      if (data.length < 5 + len) return null;
      return {
        type: "createRoom",
        name: data.subarray(5, 5 + len).toString("utf8"),
        version,
      };
    }
    if (tag === TAG.joinRoom && data.length >= 6) {
      let o = 3;
      const version = data[o++] ?? 0;
      const roomLen = data[o++] ?? 0;
      if (data.length < o + roomLen + 1) return null;
      const roomId = data.subarray(o, o + roomLen).toString("utf8");
      o += roomLen;
      const nameLen = data[o++] ?? 0;
      if (data.length < o + nameLen) return null;
      const name = data.subarray(o, o + nameLen).toString("utf8");
      return { type: "joinRoom", roomId: roomId || undefined, name, version };
    }
    if (tag === TAG.leaveRoom) return { type: "leaveRoom" };
    if (tag === TAG.deleteRoom) return { type: "deleteRoom" };
    if (tag === TAG.startRoom) return { type: "startRoom" };
    if (tag === TAG.listRooms) return { type: "listRooms" };
    if (tag === TAG.quit) return { type: "quit" };
    if (tag === TAG.heartbeat) return { type: "heartbeat" };
    if (tag === TAG.reconnect) return null;
    if (tag === TAG.input && data.length >= 4) {
      const iv = (data[3] ?? 1) - 1;
      if (iv === -1 || iv === 0 || iv === 1) {
        return { type: "input", input: iv as PaddleInput };
      }
    }
    return null;
  }
  try {
    const value = JSON.parse(data.toString("utf8")) as ClientMessage;
    if (!value || typeof value !== "object" || !("type" in value)) return null;
    if (value.type === "createRoom" && typeof value.name === "string") {
      return {
        type: "createRoom",
        name: value.name,
        version: typeof value.version === "number" ? value.version : 0,
        requestId: typeof value.requestId === "string" ? value.requestId : undefined,
        visibility:
          value.visibility === "public" || value.visibility === "private"
            ? value.visibility
            : undefined,
      };
    }
    if (
      value.type === "joinRoom" &&
      typeof value.name === "string" &&
      (value.roomId === undefined || typeof value.roomId === "string")
    ) {
      return {
        type: "joinRoom",
        name: value.name,
        roomId: value.roomId,
        version: typeof value.version === "number" ? value.version : 0,
        requestId: typeof value.requestId === "string" ? value.requestId : undefined,
      };
    }
    if (value.type === "leaveRoom") {
      return { type: "leaveRoom", requestId: typeof value.requestId === "string" ? value.requestId : undefined };
    }
    if (value.type === "deleteRoom") {
      return { type: "deleteRoom", requestId: typeof value.requestId === "string" ? value.requestId : undefined };
    }
    if (value.type === "startRoom") {
      return { type: "startRoom", requestId: typeof value.requestId === "string" ? value.requestId : undefined };
    }
    if (value.type === "listRooms") return { type: "listRooms" };
    if (value.type === "quit") {
      return { type: "quit", requestId: typeof value.requestId === "string" ? value.requestId : undefined };
    }
    if (value.type === "heartbeat") {
      return {
        type: "heartbeat",
        nowMs: typeof value.nowMs === "number" ? value.nowMs : undefined,
        reconnectToken:
          typeof value.reconnectToken === "string" ? value.reconnectToken : undefined,
      };
    }
    if (value.type === "reconnect" && typeof value.reconnectToken === "string") {
      return {
        type: "reconnect",
        reconnectToken: value.reconnectToken,
        requestId: typeof value.requestId === "string" ? value.requestId : undefined,
      };
    }
    if (
      value.type === "input" &&
      (value.input === -1 || value.input === 0 || value.input === 1)
    ) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

export function decodeServerMessage(data: Buffer): ServerMessage | null {
  if (data.length >= 3 && data[0] === MAGIC) {
    if (data[1] !== PING_PONG_PROTOCOL_VERSION) return null;
    const tag = data[2];
    if (tag === TAG.ballEvent && data.length >= 36) {
      let o = 3;
      const reasonRaw = data[o++];
      const reason =
        reasonRaw === 0 ? "wallBounce" : reasonRaw === 1 ? "paddleHit" : "reset";
      const ball = {
        x: data.readFloatLE(o),
        y: data.readFloatLE(o + 4),
        vx: data.readFloatLE(o + 8),
        vy: data.readFloatLE(o + 12),
      };
      o += 16;
      const leftScore = data.readInt16LE(o);
      o += 2;
      const rightScore = data.readInt16LE(o);
      o += 2;
      const serverTimeMs = data.readDoubleLE(o);
      o += 8;
      const sequence = data.readUInt32LE(o);
      return {
        type: "ballEvent",
        reason,
        ball,
        leftScore,
        rightScore,
        serverTimeMs,
        sequence,
      };
    }
    if (tag === TAG.inputEvent && data.length >= 17) {
      const sideRaw = data[3];
      const inputRaw = (data[4] ?? 1) - 1;
      const side = sideRaw === 0 ? "left" : sideRaw === 1 ? "right" : null;
      if (!side || (inputRaw !== -1 && inputRaw !== 0 && inputRaw !== 1)) {
        return null;
      }
      return {
        type: "inputEvent",
        side,
        input: inputRaw as PaddleInput,
        serverTimeMs: data.readDoubleLE(5),
        sequence: data.readUInt32LE(13),
      };
    }
  }
  try {
    const value = JSON.parse(data.toString("utf8")) as ServerMessage & {
      _protocolVersion?: number;
    };
    if (!value || typeof value !== "object" || !("type" in value)) return null;
    switch (value.type) {
      case "roomCreated":
      case "roomJoined":
        if (
          isNonEmptyString(value.roomId) &&
          (value.role === "host" || value.role === "guest") &&
          (value.side === "left" || value.side === "right") &&
          typeof value.connected === "number"
        ) {
          return value;
        }
        return null;
      case "roomWaiting":
        if (isNonEmptyString(value.roomId) && typeof value.connected === "number") {
          return value;
        }
        return null;
      case "roomLeft":
      case "roomDeleted":
      case "roomStarted":
        return isNonEmptyString(value.roomId) ? value : null;
      case "roomFinished":
        if (
          isNonEmptyString(value.roomId) &&
          (value.winner === "left" || value.winner === "right") &&
          typeof value.leftScore === "number" &&
          typeof value.rightScore === "number"
        ) {
          return value;
        }
        return null;
      case "lobbyState":
        if (!Array.isArray(value.rooms) || !value.you || typeof value.you !== "object") {
          return null;
        }
        for (const room of value.rooms) {
          if (
            !room ||
            typeof room !== "object" ||
            !isNonEmptyString((room as { roomId?: unknown }).roomId) ||
            !isNonEmptyString((room as { hostName?: unknown }).hostName) ||
            typeof (room as { connected?: unknown }).connected !== "number" ||
            typeof (room as { running?: unknown }).running !== "boolean"
          ) {
            return null;
          }
        }
        if (
          (value.you.roomId !== undefined && !isNonEmptyString(value.you.roomId)) ||
          (value.you.role !== undefined &&
            value.you.role !== "host" &&
            value.you.role !== "guest") ||
          (value.you.side !== undefined &&
            value.you.side !== "left" &&
            value.you.side !== "right")
        ) {
          return null;
        }
        return value;
      case "roomState":
        if (
          value.state &&
          typeof value.state === "object" &&
          isNonEmptyString(value.state.roomId) &&
          isNonEmptyString(value.state.hostName) &&
          typeof value.state.connected === "number" &&
          typeof value.state.running === "boolean" &&
          typeof value.state.roomVersion === "number" &&
          typeof value.state.leftScore === "number" &&
          typeof value.state.rightScore === "number"
        ) {
          return value;
        }
        return null;
      case "roomError":
        if (isNonEmptyString(value.code) && isNonEmptyString(value.message)) return value;
        return null;
      case "playerAssigned":
        return value.side === "left" || value.side === "right" ? value : null;
      case "gameStart":
        if (
          isValidGameState(value.state) &&
          typeof value.serverTimeMs === "number" &&
          typeof value.sequence === "number"
        ) {
          return value;
        }
        return null;
      case "ballEvent": {
        const reasonOk =
          value.reason === "wallBounce" ||
          value.reason === "paddleHit" ||
          value.reason === "reset";
        if (
          reasonOk &&
          isValidBallState(value.ball) &&
          typeof value.leftScore === "number" &&
          typeof value.rightScore === "number" &&
          typeof value.serverTimeMs === "number" &&
          typeof value.sequence === "number"
        ) {
          return value;
        }
        return null;
      }
      case "inputEvent":
        if (
          (value.side === "left" || value.side === "right") &&
          (value.input === -1 || value.input === 0 || value.input === 1) &&
          typeof value.serverTimeMs === "number" &&
          typeof value.sequence === "number"
        ) {
          return value;
        }
        return null;
      case "versionMismatch":
        if (
          typeof value.expectedVersion === "number" &&
          typeof value.actualVersion === "number"
        ) {
          return value;
        }
        return null;
      case "reconnectAccepted":
        if (value.roomId === undefined || isNonEmptyString(value.roomId)) return value;
        return null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
