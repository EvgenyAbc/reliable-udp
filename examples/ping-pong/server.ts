import { randomInt } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  CHANNEL_EVENT,
  CHANNEL_INPUT,
  type BallEventReason,
  type ClientMessage,
  type GameState,
  type PaddleInput,
  type RoomPhase,
  type RoomVisibility,
  type Side,
  type ServerMessage,
  PING_PONG_PROTOCOL_VERSION,
  decodeClientMessage,
  encodeMessage,
} from "./protocol.js";
import {
  createPingPongProtocolConfig,
  createServerAdapter,
  type ServerPeer,
} from "./udpAdapter.js";

const PORT = Number(process.env.PING_PONG_PORT ?? 7777);
const TICK_MS = 1000 / 60;

const FIELD_W = 800;
const FIELD_H = 450;
const PADDLE_H = 90;
const PADDLE_W = 12;
const BALL = 12;
const PADDLE_SPEED = 320;
const BALL_SPEED = 290;
const WIN_SCORE = 5;
const MATCH_START_COUNTDOWN_MS = 5000;
const CONTROL_RATE_WINDOW_MS = 1000;
const CONTROL_RATE_MAX = 30;
const HEARTBEAT_TIMEOUT_MS = 15000;
const REQUEST_CACHE_MS = 120000;

const leftPaddleX = 28;
const rightPaddleX = FIELD_W - 28 - PADDLE_W;

interface Player {
  peer: ServerPeer;
  name: string;
  side: Side;
  input: PaddleInput;
}

const peers = new Map<string, ServerPeer>();
const peerToRoom = new Map<string, string>();
const rooms = new Map<string, RoomState>();

interface RoomState {
  id: string;
  phase: RoomPhase;
  visibility: RoomVisibility;
  roomVersion: number;
  startedAtMs: number | null;
  host: Player;
  guest: Player | null;
  state: GameState;
  snapshotSequence: number;
  prevBallVx: number | null;
  prevBallVy: number | null;
}

interface PeerMeta {
  lastSeenMs: number;
  lastActionWindowStartMs: number;
  lastActionCount: number;
  requestCache: Map<string, number>;
}

const peerMeta = new Map<string, PeerMeta>();
const quickMatchQueue: string[] = [];
let lobbyVersion = 0;
const ROOM_ERR = {
  alreadyInRoom: "ALREADY_IN_ROOM",
  invalidPhase: "INVALID_PHASE",
} as const;

function getMembership(peerId: string): {
  roomId: string | null;
  role: "host" | "guest" | null;
  side: Side | null;
} {
  const roomId = peerToRoom.get(peerId);
  if (!roomId) return { roomId: null, role: null, side: null };
  const room = rooms.get(roomId);
  if (!room) return { roomId: null, role: null, side: null };
  if (room.host.peer.id === peerId) {
    return { roomId, role: "host", side: room.host.side };
  }
  if (room.guest?.peer.id === peerId) {
    return { roomId, role: "guest", side: room.guest.side };
  }
  return { roomId: null, role: null, side: null };
}

function getRoomForPeer(peerId: string): RoomState | null {
  const roomId = peerToRoom.get(peerId);
  if (!roomId) return null;
  return rooms.get(roomId) ?? null;
}

function assertServerInvariants(context: string): void {
  const seenPeers = new Set<string>();
  for (const [peerId, roomId] of peerToRoom.entries()) {
    if (!rooms.has(roomId)) {
      console.warn(`[invariant] stale peerToRoom ${peerId}->${roomId} during ${context}`);
    }
  }
  for (const room of rooms.values()) {
    if (!room.host) {
      console.warn(`[invariant] missing host in room ${room.id} during ${context}`);
      continue;
    }
    const hostId = room.host.peer.id;
    if (seenPeers.has(hostId)) {
      console.warn(`[invariant] duplicate peer membership ${hostId} during ${context}`);
    }
    seenPeers.add(hostId);
    if (room.guest) {
      const guestId = room.guest.peer.id;
      if (seenPeers.has(guestId)) {
        console.warn(`[invariant] duplicate peer membership ${guestId} during ${context}`);
      }
      seenPeers.add(guestId);
    }
  }
  for (const roomId of quickMatchQueue) {
    const room = rooms.get(roomId);
    if (!room) {
      console.warn(`[invariant] stale quickMatchQueue entry ${roomId} during ${context}`);
      continue;
    }
    if (room.visibility !== "public") {
      console.warn(`[invariant] private room in quickMatchQueue ${roomId} during ${context}`);
    }
  }
}

function logRoomAction(action: string, peer: ServerPeer, detail: string): void {
  console.log(`[room_action] action=${action} peer=${peer.id} ${detail}`);
}

/** Only advertise rooms strangers can join; hide countdown, in-progress match, or finished teardown. */
function roomIsListedInLobby(room: RoomState): boolean {
  return room.phase === "open" && !room.guest;
}

function buildLobbyStateFor(peerId: string): ServerMessage {
  const roomsView = [...rooms.values()]
    .filter(roomIsListedInLobby)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((room) => ({
      roomId: room.id,
      hostName: room.host.name,
      connected: room.guest ? 2 : 1,
      running: room.state.running,
      phase: room.phase,
      visibility: room.visibility,
      roomVersion: room.roomVersion,
    }));
  const membership = getMembership(peerId);
  return {
    type: "lobbyState",
    rooms: roomsView,
    lobbyVersion,
    you: {
      roomId: membership.roomId ?? undefined,
      role: membership.role ?? undefined,
      side: membership.side ?? undefined,
    },
  };
}

function buildRoomState(room: RoomState): ServerMessage {
  return {
    type: "roomState",
    state: {
      roomId: room.id,
      hostName: room.host.name,
      guestName: room.guest?.name,
      connected: room.guest ? 2 : 1,
      running: room.state.running,
      phase: room.phase,
      visibility: room.visibility,
      roomVersion: room.roomVersion,
      leftScore: room.state.leftScore,
      rightScore: room.state.rightScore,
      startedAtMs: room.startedAtMs ?? undefined,
    },
  };
}

function broadcastRoomState(room: RoomState): void {
  broadcastRoom(room, buildRoomState(room));
}

function sendLobbyState(peer: ServerPeer): void {
  peer.connection.sendReliable(CHANNEL_EVENT, encodeMessage(buildLobbyStateFor(peer.id)), true);
}

function broadcastLobbyStates(): void {
  lobbyVersion += 1;
  for (const peer of peers.values()) {
    sendLobbyState(peer);
  }
}

function createInitialState(): GameState {
  return {
    ball: {
      x: FIELD_W / 2,
      y: FIELD_H / 2,
      vx: BALL_SPEED,
      vy: BALL_SPEED * 0.7,
    },
    leftY: FIELD_H / 2 - PADDLE_H / 2,
    rightY: FIELD_H / 2 - PADDLE_H / 2,
    leftScore: 0,
    rightScore: 0,
    running: false,
  };
}

const metrics = {
  tickDriftMs: [] as number[],
  updateDurationMs: [] as number[],
  outgoingByType: new Map<string, { count: number; bytes: number }>(),
};

function recordOutgoing(payload: object): void {
  const type =
    "type" in payload && typeof payload.type === "string" ? payload.type : "unknown";
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  const prev = metrics.outgoingByType.get(type) ?? { count: 0, bytes: 0 };
  prev.count += 1;
  prev.bytes += bytes;
  metrics.outgoingByType.set(type, prev);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx] ?? 0;
}

function logMetrics(): void {
  if (metrics.tickDriftMs.length === 0 && metrics.updateDurationMs.length === 0) {
    return;
  }
  const driftP50 = percentile(metrics.tickDriftMs, 0.5).toFixed(2);
  const driftP95 = percentile(metrics.tickDriftMs, 0.95).toFixed(2);
  const driftMax = Math.max(0, ...metrics.tickDriftMs).toFixed(2);
  const updP50 = percentile(metrics.updateDurationMs, 0.5).toFixed(3);
  const updP95 = percentile(metrics.updateDurationMs, 0.95).toFixed(3);
  const updMax = Math.max(0, ...metrics.updateDurationMs).toFixed(3);
  const byType = [...metrics.outgoingByType.entries()]
    .map(([type, v]) => `${type}=count:${v.count},bytes:${v.bytes}`)
    .join(" ");
  console.log(
    `[metrics] tickDriftMs(p50/p95/max)=${driftP50}/${driftP95}/${driftMax} updateMs(p50/p95/max)=${updP50}/${updP95}/${updMax} ${byType}`,
  );
  metrics.tickDriftMs.length = 0;
  metrics.updateDurationMs.length = 0;
  metrics.outgoingByType.clear();
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function sendReliable(player: Player, payload: ServerMessage): void {
  recordOutgoing(payload);
  player.peer.connection.sendReliable(
    CHANNEL_EVENT,
    encodeMessage(payload),
    true,
  );
}

function broadcastRoom(room: RoomState, payload: ServerMessage): void {
  const players = getRoomPlayers(room);
  for (const player of players) {
    sendReliable(player, payload);
  }
}

function emitBallEvent(room: RoomState, reason: BallEventReason): void {
  const state = room.state;
  broadcastRoom(room, {
    type: "ballEvent",
    reason,
    ball: {
      x: state.ball.x,
      y: state.ball.y,
      vx: state.ball.vx,
      vy: state.ball.vy,
    },
    leftScore: state.leftScore,
    rightScore: state.rightScore,
    serverTimeMs: Date.now(),
    sequence: room.snapshotSequence++,
  });
}

function getRoomPlayers(room: RoomState): Player[] {
  return room.guest ? [room.host, room.guest] : [room.host];
}

function sendRoomError(peer: ServerPeer, code: string, message: string): void {
  peer.connection.sendReliable(
    CHANNEL_EVENT,
    encodeMessage({
      type: "roomError",
      code,
      message:
        code === "ROOM_FULL" || code === "ROOM_NOT_FOUND"
          ? `${message} [retryAfterMs=400 suggestedAction=refresh]`
          : message,
    }),
    true,
  );
}

function getPeerMeta(peerId: string): PeerMeta {
  const now = Date.now();
  const existing = peerMeta.get(peerId);
  if (existing) return existing;
  const created: PeerMeta = {
    lastSeenMs: now,
    lastActionWindowStartMs: now,
    lastActionCount: 0,
    requestCache: new Map(),
  };
  peerMeta.set(peerId, created);
  return created;
}

function markSeen(peerId: string): void {
  getPeerMeta(peerId).lastSeenMs = Date.now();
}

function validateRateLimit(peer: ServerPeer): boolean {
  const now = Date.now();
  const meta = getPeerMeta(peer.id);
  if (now - meta.lastActionWindowStartMs > CONTROL_RATE_WINDOW_MS) {
    meta.lastActionWindowStartMs = now;
    meta.lastActionCount = 0;
  }
  meta.lastActionCount += 1;
  if (meta.lastActionCount > CONTROL_RATE_MAX) {
    sendRoomError(peer, "RATE_LIMITED", "Too many control actions");
    return false;
  }
  return true;
}

function isDuplicateRequest(peer: ServerPeer, requestId: string | undefined): boolean {
  if (!requestId) return false;
  const now = Date.now();
  const meta = getPeerMeta(peer.id);
  for (const [id, ts] of meta.requestCache.entries()) {
    if (now - ts > REQUEST_CACHE_MS) meta.requestCache.delete(id);
  }
  if (meta.requestCache.has(requestId)) return true;
  meta.requestCache.set(requestId, now);
  return false;
}

function verifyVersion(peer: ServerPeer, version: number): boolean {
  if (version !== PING_PONG_PROTOCOL_VERSION) {
    peer.connection.sendReliable(
      CHANNEL_EVENT,
      encodeMessage({
        type: "versionMismatch",
        expectedVersion: PING_PONG_PROTOCOL_VERSION,
        actualVersion: version,
      }),
      true,
    );
    return false;
  }
  return true;
}

function generateRoomId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  while (id.length < 6) {
    id += alphabet[randomInt(0, alphabet.length)];
  }
  return id;
}

function createRoomId(): string {
  for (let i = 0; i < 64; i++) {
    const id = generateRoomId();
    if (!rooms.has(id)) return id;
  }
  throw new Error("failed to allocate room id");
}

function findAutoMatchRoom(): RoomState | null {
  for (const roomId of quickMatchQueue) {
    const room = rooms.get(roomId);
    if (!room) continue;
    if (
      room.visibility === "public" &&
      room.phase === "open" &&
      !room.guest &&
      !room.state.running
    ) {
      return room;
    }
  }
  return null;
}

function updateRoomPhase(room: RoomState): void {
  if (room.phase === "closed") return;
  if (room.phase === "starting" && room.startedAtMs && room.guest && !room.state.running) return;
  if (room.state.running) {
    room.phase = "running";
    return;
  }
  if (room.guest) room.phase = "full";
  else room.phase = "open";
}

function bumpRoomVersion(room: RoomState): void {
  room.roomVersion += 1;
}

function leaveCurrentRoom(peer: ServerPeer): void {
  const roomId = peerToRoom.get(peer.id);
  if (!roomId) return;
  const room = rooms.get(roomId);
  peerToRoom.delete(peer.id);
  if (!room) return;

  const isHost = room.host.peer.id === peer.id;
  const isGuest = room.guest?.peer.id === peer.id;
  if (!isHost && !isGuest) return;

  const other = isHost ? room.guest : room.host;
  if (other) {
    sendReliable(other, { type: "roomLeft", roomId: room.id });
  }

  if (isHost) {
    if (room.guest) {
      sendReliable(room.guest, { type: "roomDeleted", roomId: room.id });
      peerToRoom.delete(room.guest.peer.id);
    }
    room.phase = "closed";
    bumpRoomVersion(room);
    rooms.delete(room.id);
    const idx = quickMatchQueue.indexOf(room.id);
    if (idx >= 0) quickMatchQueue.splice(idx, 1);
    return;
  }

  room.guest = null;
  room.host.input = 0;
  room.state.running = false;
  room.state.leftY = FIELD_H / 2 - PADDLE_H / 2;
  room.state.rightY = FIELD_H / 2 - PADDLE_H / 2;
  resetBall(room.state, "right");
  room.prevBallVx = null;
  room.prevBallVy = null;
  room.startedAtMs = null;
  updateRoomPhase(room);
  bumpRoomVersion(room);
  sendReliable(room.host, { type: "roomWaiting", roomId: room.id, connected: 1 });
  broadcastRoomState(room);
}

function tryAutoStartRoom(room: RoomState): void {
  if (room.state.running || !room.guest || room.phase === "finishing" || room.phase === "closed")
    return;
  const now = Date.now();
  room.phase = "starting";
  bumpRoomVersion(room);
  room.state.running = false;
  room.state.leftScore = 0;
  room.state.rightScore = 0;
  room.state.leftY = FIELD_H / 2 - PADDLE_H / 2;
  room.state.rightY = FIELD_H / 2 - PADDLE_H / 2;
  room.host.input = 0;
  room.guest.input = 0;
  resetBall(room.state, randomInt(0, 2) === 0 ? "left" : "right");
  room.prevBallVx = null;
  room.prevBallVy = null;
  room.startedAtMs = now + MATCH_START_COUNTDOWN_MS;
  broadcastRoomState(room);
  broadcastLobbyStates();
}

function beginScheduledMatch(room: RoomState): void {
  if (room.state.running || room.phase !== "starting" || !room.guest || room.startedAtMs === null) return;
  room.state.running = true;
  room.startedAtMs = Date.now();
  room.phase = "running";
  bumpRoomVersion(room);
  broadcastRoom(room, { type: "roomStarted", roomId: room.id });
  broadcastRoom(room, {
    type: "gameStart",
    state: room.state,
    serverTimeMs: Date.now(),
    sequence: room.snapshotSequence++,
  });
  broadcastRoomState(room);
  broadcastLobbyStates();
}

function updateRoomStartCountdown(room: RoomState): void {
  if (room.phase !== "starting" || room.startedAtMs === null) return;
  if (!room.guest) {
    room.startedAtMs = null;
    updateRoomPhase(room);
    bumpRoomVersion(room);
    broadcastRoomState(room);
    broadcastLobbyStates();
    return;
  }
  if (Date.now() >= room.startedAtMs) beginScheduledMatch(room);
}

function finishMatch(room: RoomState, winner: Side): void {
  room.phase = "finishing";
  bumpRoomVersion(room);
  room.state.running = false;
  room.host.input = 0;
  if (room.guest) room.guest.input = 0;
  room.prevBallVx = null;
  room.prevBallVy = null;
  broadcastRoom(room, {
    type: "roomFinished",
    roomId: room.id,
    winner,
    leftScore: room.state.leftScore,
    rightScore: room.state.rightScore,
  });

  const roomId = room.id;
  const hostPlayer = room.host;
  const guestPlayer = room.guest;
  peerToRoom.delete(hostPlayer.peer.id);
  if (guestPlayer) peerToRoom.delete(guestPlayer.peer.id);
  rooms.delete(roomId);
  const qIdx = quickMatchQueue.indexOf(roomId);
  if (qIdx >= 0) quickMatchQueue.splice(qIdx, 1);

  sendReliable(hostPlayer, { type: "roomDeleted", roomId });
  if (guestPlayer) sendReliable(guestPlayer, { type: "roomDeleted", roomId });

  broadcastLobbyStates();
  assertServerInvariants("finishMatch");
}

function resetBall(state: GameState, direction: Side): void {
  const dir = direction === "left" ? -1 : 1;
  const tilt = randomInt(0, 2) === 0 ? -1 : 1;
  state.ball.x = FIELD_W / 2;
  state.ball.y = FIELD_H / 2;
  state.ball.vx = dir * BALL_SPEED;
  state.ball.vy = tilt * BALL_SPEED * 0.65;
}

function onCreateRoom(
  peer: ServerPeer,
  name: string,
  version: number,
  visibility: RoomVisibility = "public",
): void {
  if (!verifyVersion(peer, version)) return;
  const existingRoom = getRoomForPeer(peer.id);
  if (
    existingRoom &&
    existingRoom.host.peer.id === peer.id &&
    existingRoom.phase === "open" &&
    !existingRoom.guest
  ) {
    // Idempotent create: return existing hosted room instead of deleting/recreating.
    console.log(`[idempotent] createRoom reused existing room ${existingRoom.id}`);
    sendReliable(existingRoom.host, {
      type: "roomCreated",
      roomId: existingRoom.id,
      role: "host",
      side: existingRoom.host.side,
      connected: 1,
    });
    sendReliable(existingRoom.host, {
      type: "roomWaiting",
      roomId: existingRoom.id,
      connected: 1,
    });
    sendReliable(existingRoom.host, buildRoomState(existingRoom));
    sendLobbyState(peer);
    return;
  }
  if (existingRoom) {
    logRoomAction("createRoom_rejected", peer, `code=${ROOM_ERR.alreadyInRoom} room=${existingRoom.id}`);
    sendRoomError(
      peer,
      ROOM_ERR.alreadyInRoom,
      "Already in a room. Leave current room before creating a new room",
    );
    sendLobbyState(peer);
    return;
  }
  const roomId = createRoomId();
  const host: Player = { peer, name, side: "left", input: 0 };
  const room: RoomState = {
    id: roomId,
    phase: "open",
    visibility,
    roomVersion: 1,
    startedAtMs: null,
    host,
    guest: null,
    state: createInitialState(),
    snapshotSequence: 0,
    prevBallVx: null,
    prevBallVy: null,
  };
  rooms.set(roomId, room);
  if (room.visibility === "public") quickMatchQueue.push(roomId);
  peerToRoom.set(peer.id, roomId);
  console.log(`room created: ${roomId} host=${name} (${peer.id})`);
  sendReliable(host, {
    type: "roomCreated",
    roomId,
    role: "host",
    side: "left",
    connected: 1,
  });
  sendReliable(host, { type: "roomWaiting", roomId, connected: 1 });
  broadcastRoomState(room);
  broadcastLobbyStates();
  assertServerInvariants("onCreateRoom");
}

function onJoinRoom(
  peer: ServerPeer,
  roomId: string | undefined,
  name: string,
  version: number,
): void {
  if (!verifyVersion(peer, version)) return;
  const target = roomId ? rooms.get(roomId) ?? null : findAutoMatchRoom();
  if (!target) {
    sendRoomError(
      peer,
      "ROOM_NOT_FOUND",
      roomId ? `Room ${roomId} not found` : "No available room",
    );
    return;
  }
  const membership = getMembership(peer.id);
  if (membership.roomId === target.id) {
    // Idempotent join to same room: do not mutate, do not leave.
    console.log(`[idempotent] joinRoom same-room ${target.id}`);
    const role = membership.role;
    const side = membership.side;
    if (!role || !side) {
      sendRoomError(peer, "INVALID_PHASE", "Room membership state invalid");
      return;
    }
    const connected = target.guest ? 2 : 1;
    if (role === "host") {
      sendReliable(target.host, { type: "roomWaiting", roomId: target.id, connected });
    } else {
      peer.connection.sendReliable(
        CHANNEL_EVENT,
        encodeMessage({
          type: "roomJoined",
          roomId: target.id,
          role,
          side,
          connected,
        }),
        true,
      );
    }
    peer.connection.sendReliable(CHANNEL_EVENT, encodeMessage(buildRoomState(target)), true);
    sendLobbyState(peer);
    return;
  }
  if (target.phase !== "open" && target.phase !== "full") {
    logRoomAction("joinRoom_rejected", peer, `code=${ROOM_ERR.invalidPhase} room=${target.id}`);
    sendRoomError(peer, ROOM_ERR.invalidPhase, "Room is not joinable right now");
    return;
  }
  if (target.guest) {
    logRoomAction("joinRoom_rejected", peer, `code=ROOM_FULL room=${target.id}`);
    sendRoomError(peer, "ROOM_FULL", "Room already has 2 players");
    return;
  }
  if (membership.roomId && membership.roomId !== target.id) {
    leaveCurrentRoom(peer);
  }

  const hostOnLeft = randomInt(2) === 0;
  target.host.side = hostOnLeft ? "left" : "right";
  const guestSide: Side = hostOnLeft ? "right" : "left";
  const guest: Player = { peer, name, side: guestSide, input: 0 };
  target.guest = guest;
  peerToRoom.set(peer.id, target.id);
  console.log(
    `room joined: ${target.id} guest=${name} (${peer.id}) sides host=${target.host.side} guest=${guest.side}`,
  );
  sendReliable(guest, {
    type: "roomJoined",
    roomId: target.id,
    role: "guest",
    side: guest.side,
    connected: 2,
  });
  sendReliable(target.host, { type: "playerAssigned", side: target.host.side });
  sendReliable(target.host, { type: "roomWaiting", roomId: target.id, connected: 2 });
  updateRoomPhase(target);
  bumpRoomVersion(target);
  tryAutoStartRoom(target);
  broadcastRoomState(target);
  broadcastLobbyStates();
  assertServerInvariants("onJoinRoom");
}

function onLeaveRoom(peer: ServerPeer): void {
  const roomId = peerToRoom.get(peer.id);
  if (!roomId) {
    sendRoomError(peer, "NO_ROOM", "Not in a room");
    return;
  }
  leaveCurrentRoom(peer);
  peer.connection.sendReliable(
    CHANNEL_EVENT,
    encodeMessage({ type: "roomLeft", roomId }),
    true,
  );
  broadcastLobbyStates();
  assertServerInvariants("onLeaveRoom");
}

function onDeleteRoom(peer: ServerPeer): void {
  const roomId = peerToRoom.get(peer.id);
  if (!roomId) {
    sendRoomError(peer, "NO_ROOM", "Not in a room");
    return;
  }
  const room = rooms.get(roomId);
  if (!room) {
    peerToRoom.delete(peer.id);
    sendRoomError(peer, "NO_ROOM", "Room no longer exists");
    return;
  }
  if (room.host.peer.id !== peer.id) {
    sendRoomError(peer, "NOT_HOST", "Only host can delete room");
    return;
  }
  if (room.guest) {
    sendReliable(room.guest, { type: "roomDeleted", roomId });
    peerToRoom.delete(room.guest.peer.id);
  }
  sendReliable(room.host, { type: "roomDeleted", roomId });
  peerToRoom.delete(room.host.peer.id);
  room.phase = "closed";
  bumpRoomVersion(room);
  rooms.delete(roomId);
  const idx = quickMatchQueue.indexOf(roomId);
  if (idx >= 0) quickMatchQueue.splice(idx, 1);
  broadcastLobbyStates();
  assertServerInvariants("onDeleteRoom");
}

function onStartRoom(peer: ServerPeer): void {
  const roomId = peerToRoom.get(peer.id);
  if (!roomId) {
    sendRoomError(peer, "NO_ROOM", "Not in a room");
    return;
  }
  const room = rooms.get(roomId);
  if (!room) {
    peerToRoom.delete(peer.id);
    sendRoomError(peer, "NO_ROOM", "Room no longer exists");
    return;
  }
  if (room.host.peer.id !== peer.id) {
    sendRoomError(peer, "NOT_HOST", "Only host can start room");
    return;
  }
  if (room.state.running || room.phase === "running" || room.phase === "starting") {
    logRoomAction("startRoom_rejected", peer, `code=${ROOM_ERR.invalidPhase} room=${room.id}`);
    sendRoomError(peer, ROOM_ERR.invalidPhase, "Room already running");
    return;
  }
  if (!room.guest) {
    logRoomAction("startRoom_rejected", peer, `code=${ROOM_ERR.invalidPhase} room=${room.id}`);
    sendRoomError(peer, ROOM_ERR.invalidPhase, "Room requires 2 players before start");
    return;
  }
  tryAutoStartRoom(room);
  sendLobbyState(peer);
  assertServerInvariants("onStartRoom");
}

function onQuit(peer: ServerPeer): void {
  leaveCurrentRoom(peer);
  broadcastLobbyStates();
  assertServerInvariants("onQuit");
}

function handleEventMessage(peer: ServerPeer, msg: ClientMessage): void {
  markSeen(peer.id);
  if (!validateRateLimit(peer)) return;
  const requestId =
    msg.type === "createRoom" ||
    msg.type === "joinRoom" ||
    msg.type === "leaveRoom" ||
    msg.type === "deleteRoom" ||
    msg.type === "startRoom" ||
    msg.type === "quit" ||
    msg.type === "reconnect"
      ? msg.requestId
      : undefined;
  if (isDuplicateRequest(peer, requestId)) return;
  if (msg.type === "createRoom") onCreateRoom(peer, msg.name, msg.version, msg.visibility);
  else if (msg.type === "joinRoom") onJoinRoom(peer, msg.roomId, msg.name, msg.version);
  else if (msg.type === "leaveRoom") onLeaveRoom(peer);
  else if (msg.type === "deleteRoom") onDeleteRoom(peer);
  else if (msg.type === "startRoom") onStartRoom(peer);
  else if (msg.type === "listRooms") sendLobbyState(peer);
  else if (msg.type === "heartbeat") markSeen(peer.id);
  else if (msg.type === "reconnect") {
    peer.connection.sendReliable(
      CHANNEL_EVENT,
      encodeMessage({ type: "reconnectAccepted", roomId: getMembership(peer.id).roomId ?? undefined }),
      true,
    );
    sendLobbyState(peer);
  } else if (msg.type === "quit") onQuit(peer);
}

function updateRoom(room: RoomState, dt: number): void {
  const state = room.state;
  if (!state.running && room.phase !== "starting") return;
  const left = room.host.side === "left" ? room.host : room.guest;
  const right = room.host.side === "right" ? room.host : room.guest;
  if (!left || !right) return;

  state.leftY = clamp(
    state.leftY + left.input * PADDLE_SPEED * dt,
    0,
    FIELD_H - PADDLE_H,
  );
  state.rightY = clamp(
    state.rightY + right.input * PADDLE_SPEED * dt,
    0,
    FIELD_H - PADDLE_H,
  );

  if (!state.running) return;

  // Sweep the tick in bounded substeps so paddle collisions are resolved continuously.
  let remaining = dt;
  while (remaining > 1e-9) {
    const maxSpeed = Math.max(Math.abs(state.ball.vx), Math.abs(state.ball.vy), 1);
    const maxStep = (BALL * 0.5) / maxSpeed;
    const step = Math.min(remaining, maxStep);
    remaining -= step;

    const prevX = state.ball.x;
    state.ball.x += state.ball.vx * step;
    state.ball.y += state.ball.vy * step;

    if (state.ball.y < 0) {
      state.ball.y = -state.ball.y;
      state.ball.vy = -state.ball.vy;
    } else if (state.ball.y > FIELD_H - BALL) {
      state.ball.y = 2 * (FIELD_H - BALL) - state.ball.y;
      state.ball.vy = -state.ball.vy;
    }

    const ballTop = state.ball.y;
    const ballBottom = state.ball.y + BALL;
    const leftOverlap = ballBottom >= state.leftY && ballTop <= state.leftY + PADDLE_H;
    const rightOverlap = ballBottom >= state.rightY && ballTop <= state.rightY + PADDLE_H;

    const leftFaceX = leftPaddleX + PADDLE_W;
    if (
      state.ball.vx < 0 &&
      prevX >= leftFaceX &&
      state.ball.x <= leftFaceX &&
      leftOverlap
    ) {
      state.ball.x = leftFaceX;
      state.ball.vx = Math.abs(state.ball.vx);
      const hit = ((state.ball.y + BALL / 2 - (state.leftY + PADDLE_H / 2)) / PADDLE_H) * 2;
      state.ball.vy = clamp(state.ball.vy + hit * 90, -BALL_SPEED * 1.1, BALL_SPEED * 1.1);
    }

    const rightFaceX = rightPaddleX - BALL;
    if (
      state.ball.vx > 0 &&
      prevX <= rightFaceX &&
      state.ball.x >= rightFaceX &&
      rightOverlap
    ) {
      state.ball.x = rightFaceX;
      state.ball.vx = -Math.abs(state.ball.vx);
      const hit = ((state.ball.y + BALL / 2 - (state.rightY + PADDLE_H / 2)) / PADDLE_H) * 2;
      state.ball.vy = clamp(state.ball.vy + hit * 90, -BALL_SPEED * 1.1, BALL_SPEED * 1.1);
    }

    if (state.ball.x < -BALL) {
      state.rightScore += 1;
      if (state.rightScore >= WIN_SCORE) {
        finishMatch(room, "right");
        return;
      }
      resetBall(state, "left");
      emitBallEvent(room, "reset");
      room.prevBallVx = null;
      room.prevBallVy = null;
      return;
    }
    if (state.ball.x > FIELD_W + BALL) {
      state.leftScore += 1;
      if (state.leftScore >= WIN_SCORE) {
        finishMatch(room, "left");
        return;
      }
      resetBall(state, "right");
      emitBallEvent(room, "reset");
      room.prevBallVx = null;
      room.prevBallVy = null;
      return;
    }
  }

  const vx = state.ball.vx;
  const vy = state.ball.vy;

  if (room.prevBallVx !== null && room.prevBallVy !== null) {
    const vxFlip = Math.sign(vx) !== Math.sign(room.prevBallVx);
    const vyFlip = Math.sign(vy) !== Math.sign(room.prevBallVy);
    // At most one event per tick so clients do not apply duplicate authoritative snaps.
    if (vxFlip) emitBallEvent(room, "paddleHit");
    else if (vyFlip) emitBallEvent(room, "wallBounce");
  }

  room.prevBallVx = vx;
  room.prevBallVy = vy;
}

function wirePeer(peer: ServerPeer): void {
  peers.set(peer.id, peer);
  getPeerMeta(peer.id);
  sendLobbyState(peer);
  peer.connection.on("message", (event) => {
    if (event.channel === CHANNEL_EVENT) {
      const msg = decodeClientMessage(event.data);
      if (msg) handleEventMessage(peer, msg);
    }
    if (event.channel === CHANNEL_INPUT) {
      const msg = decodeClientMessage(event.data);
      if (msg?.type === "input") {
        const roomId = peerToRoom.get(peer.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        if (!room.state.running && room.phase !== "starting") return;
        const player =
          room.host.peer.id === peer.id
            ? room.host
            : room.guest?.peer.id === peer.id
              ? room.guest
              : null;
        if (player && player.input !== msg.input) {
          player.input = msg.input;
          broadcastRoom(room, {
            type: "inputEvent",
            side: player.side,
            input: msg.input,
            serverTimeMs: Date.now(),
            sequence: room.snapshotSequence++,
          });
        }
      }
    }
  });
}

function evictStalePeers(): void {
  const now = Date.now();
  for (const [peerId, meta] of peerMeta.entries()) {
    if (now - meta.lastSeenMs > HEARTBEAT_TIMEOUT_MS) {
      const peer = peers.get(peerId);
      if (!peer) continue;
      console.log(`evict stale peer: ${peerId}`);
      onQuit(peer);
      peers.delete(peerId);
      peerMeta.delete(peerId);
    }
  }
}

createServerAdapter(PORT, wirePeer, createPingPongProtocolConfig());
console.log(`ping-pong server listening on 0.0.0.0:${PORT}`);
setInterval(logMetrics, 2000);
setInterval(evictStalePeers, 2000);

const FIXED_DT_SEC = TICK_MS / 1000;
let previousNow = performance.now();
let accumulatorMs = 0;
setInterval(() => {
  const frameStart = performance.now();
  const now = frameStart;
  const frameDeltaMs = Math.min(250, now - previousNow);
  previousNow = now;
  accumulatorMs += frameDeltaMs;
  metrics.tickDriftMs.push(Math.abs(frameDeltaMs - TICK_MS));

  let steps = 0;
  while (accumulatorMs >= TICK_MS && steps < 5) {
    const updateStart = performance.now();
    for (const room of rooms.values()) {
      updateRoomStartCountdown(room);
      updateRoom(room, FIXED_DT_SEC);
    }
    metrics.updateDurationMs.push(performance.now() - updateStart);
    accumulatorMs -= TICK_MS;
    steps++;
  }

  if (steps === 5 && accumulatorMs >= TICK_MS) {
    accumulatorMs = 0;
  }
}, 1);
