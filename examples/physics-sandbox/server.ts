import Matter from "matter-js";
import {
  CHANNEL_EVENT,
  CHANNEL_INPUT,
  CHANNEL_STATE,
  decodeClientMessage,
  encodeMessage,
  type BodySnapshot,
} from "./protocol.js";
import { createServerAdapter, type ServerPeer } from "./udpAdapter.js";

const PORT = Number(process.env.PHYSICS_PORT ?? 7778);
const TICK_MS = 1000 / 60;
const SNAPSHOT_MS = Number(process.env.PHYSICS_SNAPSHOT_MS ?? 33);

const WORLD_W = 800;
const WORLD_H = 450;
const MAX_BODIES = 64;
const MIN_SPAWN_INTERVAL_MS = 200;
const PLAYER_R = 14;
const BOX_W = 28;
const BOX_H = 28;
const MOVE_SPEED = 280;

const MATTER_BASE_DELTA_MS = 1000 / 60;

function matterVelocityFromPixelsPerSec(
  vx: number,
  vy: number,
): { x: number; y: number } {
  const k = MATTER_BASE_DELTA_MS / 1000;
  return { x: vx * k, y: vy * k };
}

interface PeerPlayer {
  peer: ServerPeer;
  bodyId: number;
}

const players = new Map<string, PeerPlayer>();
const lastInput = new Map<string, { ax: number; ay: number }>();
const lastSpawnMs = new Map<string, number>();

let nextBodyId = 1;
const idToBody = new Map<number, Matter.Body>();
const bodyKind = new Map<number, "player" | "box">();
/** FIFO of dynamic box ids for eviction when over capacity */
const boxSpawnOrder: number[] = [];

let snapshotSequence = 0;

const engine = Matter.Engine.create({
  gravity: { x: 0, y: 1 },
  enableSleeping: false,
});

const wallThickness = 60;
const floor = Matter.Bodies.rectangle(
  WORLD_W / 2,
  WORLD_H + wallThickness / 2,
  WORLD_W + 400,
  wallThickness,
  {
    isStatic: true,
  },
);
const ceiling = Matter.Bodies.rectangle(
  WORLD_W / 2,
  -wallThickness / 2,
  WORLD_W + 400,
  wallThickness,
  {
    isStatic: true,
  },
);
const wallLeft = Matter.Bodies.rectangle(
  -wallThickness / 2,
  WORLD_H / 2,
  wallThickness,
  WORLD_H + 400,
  {
    isStatic: true,
  },
);
const wallRight = Matter.Bodies.rectangle(
  WORLD_W + wallThickness / 2,
  WORLD_H / 2,
  wallThickness,
  WORLD_H + 400,
  { isStatic: true },
);

Matter.World.add(engine.world, [floor, ceiling, wallLeft, wallRight]);

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function registerBody(body: Matter.Body, kind: "player" | "box"): number {
  const id = nextBodyId++;
  idToBody.set(id, body);
  bodyKind.set(id, kind);
  if (kind === "box") boxSpawnOrder.push(id);
  Matter.World.add(engine.world, body);
  return id;
}

function removeBody(id: number): Matter.Body | undefined {
  const body = idToBody.get(id);
  if (!body) return undefined;
  Matter.Composite.remove(engine.world, body);
  idToBody.delete(id);
  bodyKind.delete(id);
  const idx = boxSpawnOrder.indexOf(id);
  if (idx >= 0) boxSpawnOrder.splice(idx, 1);
  return body;
}

function broadcastReliable(payload: object): void {
  const wire = encodeMessage(payload as never);
  for (const { peer } of players.values()) {
    peer.connection.sendReliable(CHANNEL_EVENT, wire, true);
  }
}

function sendReliable(peer: ServerPeer, payload: object): void {
  peer.connection.sendReliable(
    CHANNEL_EVENT,
    encodeMessage(payload as never),
    true,
  );
}

function broadcastSnapshot(): void {
  const bodies: BodySnapshot[] = [];
  for (const [id, body] of idToBody) {
    const kind = bodyKind.get(id);
    if (!kind) continue;
    if (kind === "player") {
      bodies.push({
        id,
        kind,
        x: body.position.x,
        y: body.position.y,
        angle: body.angle,
        r: PLAYER_R,
      });
    } else {
      const w = body.bounds.max.x - body.bounds.min.x;
      const h = body.bounds.max.y - body.bounds.min.y;
      bodies.push({
        id,
        kind,
        x: body.position.x,
        y: body.position.y,
        angle: body.angle,
        w,
        h,
      });
    }
  }
  bodies.sort((a, b) => a.id - b.id);

  const wire = encodeMessage({
    type: "snapshot",
    bodies,
    serverTimeMs: Date.now(),
    sequence: snapshotSequence++,
  });
  for (const { peer } of players.values()) {
    peer.connection.sendUnreliable(CHANNEL_STATE, wire);
  }
}

function evictOldestBoxIfNeeded(): void {
  while (idToBody.size >= MAX_BODIES && boxSpawnOrder.length > 0) {
    const victim = boxSpawnOrder.shift();
    if (victim === undefined) break;
    removeBody(victim);
    broadcastReliable({ type: "bodyDespawn", id: victim });
  }
}

function trySpawnBox(peer: ServerPeer, x: number, y: number): void {
  const now = Date.now();
  const last = lastSpawnMs.get(peer.id) ?? 0;
  if (now - last < MIN_SPAWN_INTERVAL_MS) return;
  lastSpawnMs.set(peer.id, now);

  evictOldestBoxIfNeeded();
  if (idToBody.size >= MAX_BODIES) return;

  const cx = clamp(x, BOX_W, WORLD_W - BOX_W);
  const cy = clamp(y, BOX_H, WORLD_H - BOX_H);
  const box = Matter.Bodies.rectangle(cx, cy, BOX_W, BOX_H, {
    frictionAir: 0.02,
    restitution: 0.25,
    density: 0.002,
  });
  registerBody(box, "box");
}

function onJoin(peer: ServerPeer, name: string): void {
  if (players.has(peer.id)) return;

  const index = players.size;
  const spawnX = WORLD_W * (0.22 + index * 0.56);
  const spawnY = WORLD_H * 0.25;
  const playerBody = Matter.Bodies.circle(spawnX, spawnY, PLAYER_R, {
    frictionAir: 0.04,
    restitution: 0.2,
    density: 0.001,
  });

  const bodyId = registerBody(playerBody, "player");
  players.set(peer.id, { peer, bodyId });
  lastInput.set(peer.id, { ax: 0, ay: 0 });

  console.log(`physics sandbox join: ${name} (${peer.id}) body #${bodyId}`);

  sendReliable(peer, { type: "welcome", worldW: WORLD_W, worldH: WORLD_H });
  sendReliable(peer, { type: "assigned", bodyId });
}

function wirePeer(peer: ServerPeer): void {
  peer.connection.on("message", (event) => {
    if (event.channel === CHANNEL_EVENT) {
      const msg = decodeClientMessage(event.data);
      if (msg?.type === "join") onJoin(peer, msg.name);
      if (msg?.type === "spawn") trySpawnBox(peer, msg.x, msg.y);
    }
    if (event.channel === CHANNEL_INPUT) {
      const msg = decodeClientMessage(event.data);
      if (msg?.type === "input")
        lastInput.set(peer.id, { ax: msg.ax, ay: msg.ay });
    }
  });
}

createServerAdapter(PORT, wirePeer);
console.log(`physics sandbox server listening on 0.0.0.0:${PORT}`);

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - last) / 1000;
  last = now;

  for (const [peerId, { bodyId }] of players) {
    const body = idToBody.get(bodyId);
    const input = lastInput.get(peerId) ?? { ax: 0, ay: 0 };
    if (body) {
      Matter.Body.setVelocity(
        body,
        matterVelocityFromPixelsPerSec(
          input.ax * MOVE_SPEED,
          input.ay * MOVE_SPEED,
        ),
      );
    }
  }

  Matter.Engine.update(engine, dt * 1000);
}, TICK_MS);

setInterval(() => {
  broadcastSnapshot();
}, SNAPSHOT_MS);
