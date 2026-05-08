import { Buffer } from "node:buffer";

export const CHANNEL_EVENT = 1;
export const CHANNEL_INPUT = 2;
export const CHANNEL_STATE = 3;

export type BodyKind = "player" | "box";

export interface BodySnapshot {
  id: number;
  kind: BodyKind;
  x: number;
  y: number;
  angle: number;
  w?: number;
  h?: number;
  r?: number;
}

export type ClientMessage =
  | { type: "join"; name: string }
  | { type: "spawn"; x: number; y: number }
  | { type: "input"; ax: number; ay: number };

export type ServerMessage =
  | { type: "welcome"; worldW: number; worldH: number }
  | { type: "assigned"; bodyId: number }
  | { type: "bodyDespawn"; id: number }
  | {
      type: "snapshot";
      bodies: BodySnapshot[];
      serverTimeMs: number;
      sequence: number;
    };

export function encodeMessage(message: ClientMessage | ServerMessage): Buffer {
  return Buffer.from(JSON.stringify(message), "utf8");
}

function clampAxis(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.max(-1, Math.min(1, v));
}

export function decodeClientMessage(data: Buffer): ClientMessage | null {
  try {
    const value = JSON.parse(data.toString("utf8")) as ClientMessage;
    if (!value || typeof value !== "object" || !("type" in value)) return null;
    if (value.type === "join" && typeof value.name === "string") return value;
    if (
      value.type === "spawn" &&
      typeof value.x === "number" &&
      typeof value.y === "number" &&
      Number.isFinite(value.x) &&
      Number.isFinite(value.y)
    ) {
      return value;
    }
    if (value.type === "input") {
      const ax = clampAxis(value.ax);
      const ay = clampAxis(value.ay);
      if (ax !== null && ay !== null) return { type: "input", ax, ay };
    }
    return null;
  } catch {
    return null;
  }
}

function isBodySnapshot(b: unknown): b is BodySnapshot {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.id === "number" &&
    (o.kind === "player" || o.kind === "box") &&
    typeof o.x === "number" &&
    typeof o.y === "number" &&
    typeof o.angle === "number" &&
    (o.w === undefined || typeof o.w === "number") &&
    (o.h === undefined || typeof o.h === "number") &&
    (o.r === undefined || typeof o.r === "number")
  );
}

export function decodeServerMessage(data: Buffer): ServerMessage | null {
  try {
    const value = JSON.parse(data.toString("utf8")) as ServerMessage;
    if (!value || typeof value !== "object" || !("type" in value)) return null;
    switch (value.type) {
      case "welcome":
        return typeof value.worldW === "number" &&
          typeof value.worldH === "number"
          ? value
          : null;
      case "assigned":
        return typeof value.bodyId === "number" ? value : null;
      case "bodyDespawn":
        return typeof value.id === "number" ? value : null;
      case "snapshot":
        if (
          typeof value.serverTimeMs === "number" &&
          typeof value.sequence === "number" &&
          Array.isArray(value.bodies) &&
          value.bodies.every(isBodySnapshot)
        ) {
          return value;
        }
        return null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
