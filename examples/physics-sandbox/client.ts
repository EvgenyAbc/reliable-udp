import { Buffer } from "node:buffer";
import sdl from "@kmamal/sdl";
import {
  CHANNEL_EVENT,
  CHANNEL_INPUT,
  CHANNEL_STATE,
  type BodySnapshot,
  decodeServerMessage,
  encodeMessage,
} from "./protocol.js";
import { createClientAdapter } from "./udpAdapter.js";

const host = process.argv[2] ?? process.env.PHYSICS_HOST ?? "127.0.0.1";
const port = Number(process.argv[3] ?? process.env.PHYSICS_PORT ?? 7778);
const name =
  process.argv[4] ?? process.env.PHYSICS_NAME ?? `explorer-${process.pid}`;

const window = sdl.video.createWindow({
  title: `Physics Sandbox (${name})`,
  width: 800,
  height: 450,
});
const width = window.pixelWidth;
const height = window.pixelHeight;

const { socket, connection } = createClientAdapter({ host, port });

const local = {
  worldW: 800,
  worldH: 450,
  bodyId: null as number | null,
  bodies: [] as BodySnapshot[],
  lastSequence: -1,
  /** Normalized input in [-1, 1] per axis */
  ax: 0,
  ay: 0,
  sentAx: 0,
  sentAy: 0,
};

function putPixel(
  buffer: Buffer,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
): void {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const i = (y * width + x) * 4;
  buffer[i] = r;
  buffer[i + 1] = g;
  buffer[i + 2] = b;
  buffer[i + 3] = 255;
}

function rect(
  buffer: Buffer,
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: [number, number, number],
): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(width, Math.ceil(x + w));
  const y1 = Math.min(height, Math.ceil(y + h));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      putPixel(buffer, px, py, rgb[0], rgb[1], rgb[2]);
    }
  }
}

function pushSnapshot(bodies: BodySnapshot[], sequence: number): void {
  if (sequence <= local.lastSequence) return;
  local.lastSequence = sequence;
  local.bodies = bodies;
}

function sendInputIfChanged(): void {
  if (local.ax === local.sentAx && local.ay === local.sentAy) return;
  local.sentAx = local.ax;
  local.sentAy = local.ay;
  connection.sendUnreliable(
    CHANNEL_INPUT,
    encodeMessage({ type: "input", ax: local.ax, ay: local.ay }),
  );
}

function draw(): void {
  const frame = Buffer.alloc(width * height * 4);
  rect(frame, 0, 0, width, height, [12, 14, 18]);

  const sx = width / local.worldW;
  const sy = height / local.worldH;

  for (const b of local.bodies) {
    const isSelf = local.bodyId !== null && b.id === local.bodyId;
    const rgb: [number, number, number] = isSelf
      ? [120, 220, 255]
      : b.kind === "player"
        ? [200, 200, 120]
        : [180, 140, 220];

    if (b.kind === "player" && typeof b.r === "number") {
      const r = b.r;
      rect(frame, (b.x - r) * sx, (b.y - r) * sy, 2 * r * sx, 2 * r * sy, rgb);
    } else if (
      b.kind === "box" &&
      typeof b.w === "number" &&
      typeof b.h === "number"
    ) {
      rect(
        frame,
        (b.x - b.w / 2) * sx,
        (b.y - b.h / 2) * sy,
        b.w * sx,
        b.h * sy,
        rgb,
      );
    }
  }

  rect(frame, 0, height - 22, width, 22, [30, 80, 40]);
  window.render(width, height, width * 4, "rgba32", frame);
}

function updateMovementKeys(): void {
  let ax = 0;
  let ay = 0;
  if (keys.has("left") || keys.has("a")) ax -= 1;
  if (keys.has("right") || keys.has("d")) ax += 1;
  if (keys.has("up") || keys.has("w")) ay -= 1;
  if (keys.has("down") || keys.has("s")) ay += 1;
  local.ax = Math.max(-1, Math.min(1, ax));
  local.ay = Math.max(-1, Math.min(1, ay));
}

const keys = new Set<string>();

function registerKey(raw: unknown, down: boolean): void {
  if (!raw || typeof raw !== "object") return;
  const key = String(
    (raw as { key?: unknown; scancode?: unknown; code?: unknown }).key ??
      (raw as { scancode?: unknown }).scancode ??
      (raw as { code?: unknown }).code ??
      "",
  ).toLowerCase();
  const token = key.includes("left")
    ? "left"
    : key.includes("right")
      ? "right"
      : key.includes("up")
        ? "up"
        : key.includes("down")
          ? "down"
          : key.includes("w") && key.length <= 2
            ? "w"
            : key.includes("a") && key.length <= 2
              ? "a"
              : key.includes("s") && key.length <= 2
                ? "s"
                : key.includes("d") && key.length <= 2
                  ? "d"
                  : "";
  if (!token) return;
  if (down) keys.add(token);
  else keys.delete(token);
}

window.on("keyDown", (event: unknown) => {
  registerKey(event, true);
  updateMovementKeys();
  sendInputIfChanged();
});

window.on("keyUp", (event: unknown) => {
  registerKey(event, false);
  updateMovementKeys();
  sendInputIfChanged();
});

window.on("mouseButtonDown", (event: unknown) => {
  if (!event || typeof event !== "object") return;
  const e = event as { x?: number; y?: number; button?: number };
  if (typeof e.x !== "number" || typeof e.y !== "number") return;
  if (e.button !== sdl.mouse.BUTTON.LEFT) return;
  const wx = (e.x / width) * local.worldW;
  const wy = (e.y / height) * local.worldH;
  connection.sendReliable(
    CHANNEL_EVENT,
    encodeMessage({ type: "spawn", x: wx, y: wy }),
    true,
  );
});

window.on("close", () => {
  socket.close();
  process.exit(0);
});

connection.on("message", (event) => {
  if (event.channel === CHANNEL_EVENT) {
    const msg = decodeServerMessage(event.data);
    if (!msg) return;
    if (msg.type === "welcome") {
      local.worldW = msg.worldW;
      local.worldH = msg.worldH;
    } else if (msg.type === "assigned") {
      local.bodyId = msg.bodyId;
      console.log(`assigned body id: ${msg.bodyId}`);
    } else if (msg.type === "bodyDespawn") {
      local.bodies = local.bodies.filter((b) => b.id !== msg.id);
    }
  }
  if (event.channel === CHANNEL_STATE) {
    const msg = decodeServerMessage(event.data);
    if (msg?.type === "snapshot") {
      pushSnapshot(msg.bodies, msg.sequence);
    }
  }
});

connection.sendReliable(
  CHANNEL_EVENT,
  encodeMessage({ type: "join", name }),
  true,
);
setInterval(() => {
  connection.sendReliable(
    CHANNEL_EVENT,
    encodeMessage({ type: "join", name }),
    true,
  );
}, 2000);

setInterval(() => {
  draw();
}, 16);

setInterval(() => {
  updateMovementKeys();
  sendInputIfChanged();
}, 50);

console.log(`physics sandbox client -> ${host}:${port} as ${name}`);
