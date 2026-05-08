import sdl from "@kmamal/sdl";
import createContextImport, {
  type WebGLProgram,
  type WebGLRenderingContext,
  type WebGLShader,
} from "@kmamal/gl";
import {
  CHANNEL_EVENT,
  CHANNEL_INPUT,
  type BallState,
  type PaddleInput,
  type RoomSummary,
  type ServerMessage,
  PING_PONG_PROTOCOL_VERSION,
  decodeServerMessage,
  encodeMessage,
} from "./protocol.js";
import { createClientAdapter, createPingPongProtocolConfig } from "./udpAdapter.js";
import { createPingPongSounds } from "./sounds.js";

const host = process.argv[2] ?? process.env.PING_PONG_HOST ?? "127.0.0.1";
const port = Number(process.argv[3] ?? process.env.PING_PONG_PORT ?? 7777);
const name =
  process.argv[4] ?? process.env.PING_PONG_NAME ?? `player-${process.pid}`;
const requestedRoomId = process.argv[5] ?? process.env.PING_PONG_ROOM_ID;
const roomAction = (
  process.argv[6] ??
  process.env.PING_PONG_ROOM_ACTION ??
  (requestedRoomId ? "join" : "auto")
).toLowerCase();

/** Mirror server layout */
const FIELD_W = 800;
const FIELD_H = 450;
const PADDLE_H = 90;
const PADDLE_SPEED = 320;
const BALL = 12;
const STATUS_BAR_H = 28;
const PADDLE_W = 12;
const PADDLE_X = 28;

const CLOCK_EMA_ALPHA = 0.1;
const CLOCK_OUTLIER_MS = 120;
const SIM_STEP_MS = 1000 / 120;
const SMALL_CORRECTION_PX = 12;
const LARGE_CORRECTION_PX = 48;
const MAX_PARTICLES = 220;
const MAX_TRAIL_POINTS = 45;
const TRAIL_LIFE_SEC = 0.575;
const MAX_RIPPLES = 8;
const MAX_LOBBY_TRACE_POINTS = 24;
const LOBBY_TRACE_LIFE_SEC = 1.15;
const LOBBY_TRACE_MIN_DIST_PX = 10;
const LOBBY_TRACE_MIN_INTERVAL_MS = 24;
const MOUSE_RIPPLE_DECAY_PER_SEC = 1.22;
const MOUSE_RIPPLE_MAX_SPEED = 1400;
const MOUSE_RIPPLE_MIN_DT_MS = 8;
const BG_NOISE_CELL = 20;
const BG_NOISE_BLEND = 0.14;
const BG_NOISE_SPEED = 0.0018;
const BG_PULSE_HZ = 0.1;
const UI_PANEL_W = 500;
const UI_PANEL_H = 286;
const UI_BUTTON_W = 102;
const UI_BUTTON_H = 24;
const UI_GAP = 10;
const BOOTSTRAP_RETRY_MS = 1000;
/** Unreliable input has no ACK; re-flush during countdown so a single lost packet cannot stall echo. */
const COUNTDOWN_INPUT_FLUSH_MS = 75;

const window = sdl.video.createWindow({
  title: `Ping Pong Client (${name})`,
  width: 800,
  height: 450,
  opengl: true,
});
const width = window.pixelWidth;
const height = window.pixelHeight;
const createContext = createContextImport as unknown as (
  width: number,
  height: number,
  contextAttributes?: { window?: unknown },
) => WebGLRenderingContext | null;
const glContext = createContext(width, height, { window: window.native });
if (!glContext) throw new Error("failed to create OpenGL context");
const gl: WebGLRenderingContext = glContext;

const { socket, connection } = createClientAdapter(
  { host, port },
  createPingPongProtocolConfig(),
);
const sounds = createPingPongSounds(sdl);
let serverReachable = false;
let startupActionDispatched = false;
let bootstrapTimer: ReturnType<typeof setInterval> | null = null;
let countdownInputFlushTimer: ReturnType<typeof setInterval> | null = null;
let pendingWatchTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let simulationTimer: ReturnType<typeof setInterval> | null = null;
let renderTimer: ReturnType<typeof setInterval> | null = null;
let metricsLogTimer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

const local = {
  side: null as "left" | "right" | null,
  role: null as "host" | "guest" | null,
  roomId: null as string | null,
  phase: "lobby" as "lobby" | "waiting" | "starting" | "running" | "finished" | "error",
  input: 0 as PaddleInput,
};

const ui = {
  statusText: "Connecting...",
  errorText: "",
  rooms: [] as RoomSummary[],
  mouseX: 0,
  mouseY: 0,
  pressedButton: null as string | null,
  hoveredButton: null as string | null,
  autoCreateAttempted: false,
  resultVisible: false,
  resultWinner: null as "left" | "right" | null,
  resultKind: null as "win" | "lose" | null,
  resultDismissAtMs: 0,
  pendingFinish: null as {
    roomId: string;
    winner: "left" | "right";
    leftScore: number;
    rightScore: number;
  } | null,
  pendingAction: null as string | null,
  pendingActionUntilMs: 0,
  countdownTargetMs: 0,
};

const movementKeys = {
  upHeld: false,
  downHeld: false,
  lastDirectionPressed: 0 as PaddleInput,
};

let soundLastCountdownSec: number | null = null;

interface UiButton {
  id: "create" | "refresh" | "leave" | "start" | "quit";
  x: number;
  y: number;
  w: number;
  h: number;
  enabled: boolean;
}

interface LobbyLayout {
  panelX: number;
  panelY: number;
  headerY: number;
  statusY: number;
  buttonsY: number;
  listY: number;
  listRowH: number;
  listRowGap: number;
  listRows: number;
  footerY: number;
}

const FONT_3X5: Record<string, string[]> = {
  A: ["111", "101", "111", "101", "101"],
  B: ["110", "101", "110", "101", "110"],
  C: ["111", "100", "100", "100", "111"],
  D: ["110", "101", "101", "101", "110"],
  E: ["111", "100", "110", "100", "111"],
  F: ["111", "100", "110", "100", "100"],
  G: ["111", "100", "101", "101", "111"],
  H: ["101", "101", "111", "101", "101"],
  I: ["111", "010", "010", "010", "111"],
  J: ["001", "001", "001", "101", "111"],
  K: ["101", "101", "110", "101", "101"],
  L: ["100", "100", "100", "100", "111"],
  M: ["101", "111", "111", "101", "101"],
  N: ["101", "111", "111", "111", "101"],
  O: ["111", "101", "101", "101", "111"],
  P: ["111", "101", "111", "100", "100"],
  Q: ["111", "101", "101", "111", "001"],
  R: ["111", "101", "111", "110", "101"],
  S: ["111", "100", "111", "001", "111"],
  T: ["111", "010", "010", "010", "010"],
  U: ["101", "101", "101", "101", "111"],
  V: ["101", "101", "101", "101", "010"],
  W: ["101", "101", "111", "111", "101"],
  X: ["101", "101", "010", "101", "101"],
  Y: ["101", "101", "010", "010", "010"],
  Z: ["111", "001", "010", "100", "111"],
  0: ["111", "101", "101", "101", "111"],
  1: ["010", "110", "010", "010", "111"],
  2: ["111", "001", "111", "100", "111"],
  3: ["111", "001", "111", "001", "111"],
  4: ["101", "101", "111", "001", "001"],
  5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"],
  7: ["111", "001", "010", "100", "100"],
  8: ["111", "101", "111", "101", "111"],
  9: ["111", "101", "111", "001", "111"],
  ":": ["000", "010", "000", "010", "000"],
  ".": ["000", "000", "000", "010", "000"],
  "-": ["000", "000", "111", "000", "000"],
  "/": ["001", "001", "010", "100", "100"],
  "(": ["010", "100", "100", "100", "010"],
  ")": ["010", "001", "001", "001", "010"],
  " ": ["000", "000", "000", "000", "000"],
};

let ball: BallState | null = null;
let leftY = FIELD_H / 2 - PADDLE_H / 2;
let rightY = FIELD_H / 2 - PADDLE_H / 2;
let leftScore = 0;
let rightScore = 0;
let running = false;

/** Opponent paddle input from reliable server echo */
let remoteLeftInput: PaddleInput = 0;
let remoteRightInput: PaddleInput = 0;

let clockOffsetMs: number | null = null;
let lastServerSequence = -1;
const clockSamples: number[] = [];

let lastSimulationPerf = performance.now();
let simulationAccumulatorMs = 0;

interface TimedBallSnapshot {
  sequence: number;
  serverTimeMs: number;
  ball: BallState;
}
const authoritativeBallSnapshots: TimedBallSnapshot[] = [];
const MAX_SNAPSHOTS = 128;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  r: number;
  g: number;
  b: number;
}

interface TrailPoint {
  x: number;
  y: number;
  life: number;
}

interface RipplePulse {
  x: number;
  y: number;
  startMs: number;
  durationMs: number;
  amplitude: number;
  frequency: number;
  speed: number;
  damping: number;
}

interface LobbyTracePoint {
  x: number;
  y: number;
  life: number;
  maxLife: number;
  strength: number;
}

const particles: Particle[] = [];
const trail: TrailPoint[] = [];
const ripplePulses: RipplePulse[] = [];
const lobbyTracePoints: LobbyTracePoint[] = [];
const lobbyTraceCapture = {
  hasSample: false,
  lastX: 0,
  lastY: 0,
  lastMs: 0,
};
const mouseMotionRipple = {
  centerX: 0.5,
  centerY: 0.5,
  strength: 0,
  phase: 0,
  lastX: 0,
  lastY: 0,
  lastMs: 0,
  hasSample: false,
};

const metrics = {
  correctionPx: [] as number[],
  correctionCount: 0,
  correctionSnapCount: 0,
  renderDtMs: [] as number[],
  incomingByType: new Map<string, { count: number; bytes: number }>(),
};

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function noise2D(ix: number, iy: number, t: number): number {
  const x = (ix * 374761393) ^ (iy * 668265263) ^ ((t | 0) * 1442695041);
  let h = x ^ (x >>> 13);
  h = Math.imul(h, 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) & 1023) / 1023;
}

function emitParticles(
  x: number,
  y: number,
  count: number,
  speedMin: number,
  speedMax: number,
  lifeMin: number,
  lifeMax: number,
  color: [number, number, number],
): void {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = randRange(speedMin, speedMax);
    const life = randRange(lifeMin, lifeMax);
    particles.push({
      x: x + BALL / 2,
      y: y + BALL / 2,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life,
      maxLife: life,
      size: randRange(1.8, 3.8),
      r: color[0],
      g: color[1],
      b: color[2],
    });
  }
  if (particles.length > MAX_PARTICLES) {
    particles.splice(0, particles.length - MAX_PARTICLES);
  }
}

function emitWallBounceFx(b: BallState): void {
  emitParticles(b.x, b.y, 16, 55, 165, 0.16, 0.36, [0.60, 0.84, 1.0]);
}

function emitPaddleBounceFx(b: BallState): void {
  emitParticles(b.x, b.y, 28, 90, 235, 0.2, 0.5, [1.0, 0.88, 0.42]);
}

function emitBounceRippleFx(
  b: BallState,
  reason: "wallBounce" | "paddleHit",
): void {
  const playHeight = Math.max(1, height - STATUS_BAR_H);
  const sx = width / FIELD_W;
  const sy = playHeight / FIELD_H;
  const centerX = clamp((b.x + BALL / 2) * sx, 0, width) / width;
  const centerYTop = clamp((b.y + BALL / 2) * sy, 0, playHeight) / height;
  const centerY = 1 - centerYTop;
  ripplePulses.push({
    x: centerX,
    y: centerY,
    startMs: performance.now(),
    durationMs: reason === "paddleHit" ? 720 : 560,
    amplitude: reason === "paddleHit" ? 0.014 : 0.010,
    frequency: reason === "paddleHit" ? 66 : 58,
    speed: reason === "paddleHit" ? 36 : 30,
    damping: reason === "paddleHit" ? 3.1 : 2.6,
  });
  if (ripplePulses.length > MAX_RIPPLES) {
    ripplePulses.splice(0, ripplePulses.length - MAX_RIPPLES);
  }
}

function isLobbyPostFxActive(): boolean {
  return local.phase !== "running" && local.phase !== "starting";
}

function clearLobbyTraceFx(): void {
  lobbyTracePoints.length = 0;
  lobbyTraceCapture.hasSample = false;
  mouseMotionRipple.strength = 0;
  mouseMotionRipple.phase = 0;
  mouseMotionRipple.hasSample = false;
}

function pushLobbyTracePoint(screenX: number, screenY: number, strength: number): void {
  const playHeight = Math.max(1, height - STATUS_BAR_H);
  const x = clamp(screenX, 0, width) / width;
  const yTop = clamp(screenY, 0, playHeight) / height;
  lobbyTracePoints.push({
    x,
    y: 1 - yTop,
    life: LOBBY_TRACE_LIFE_SEC,
    maxLife: LOBBY_TRACE_LIFE_SEC,
    strength: clamp(strength, 0.25, 1),
  });
  if (lobbyTracePoints.length > MAX_LOBBY_TRACE_POINTS) {
    lobbyTracePoints.splice(0, lobbyTracePoints.length - MAX_LOBBY_TRACE_POINTS);
  }
}

function pruneRipplePulses(nowMs: number): void {
  for (let i = ripplePulses.length - 1; i >= 0; i--) {
    const pulse = ripplePulses[i]!;
    if (nowMs - pulse.startMs >= pulse.durationMs) {
      ripplePulses.splice(i, 1);
    }
  }
}

function resetVisualFx(): void {
  particles.length = 0;
  trail.length = 0;
  ripplePulses.length = 0;
  clearLobbyTraceFx();
}

function updateVisualFx(dtSec: number): void {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dtSec;
    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    p.vx *= 0.992;
    p.vy *= 0.992;
    p.vy += 220 * dtSec;
    p.x += p.vx * dtSec;
    p.y += p.vy * dtSec;
  }
  for (let i = trail.length - 1; i >= 0; i--) {
    trail[i]!.life -= dtSec;
    if (trail[i]!.life <= 0) trail.splice(i, 1);
  }
  for (let i = lobbyTracePoints.length - 1; i >= 0; i--) {
    const t = lobbyTracePoints[i]!;
    t.life -= dtSec;
    if (t.life <= 0) lobbyTracePoints.splice(i, 1);
  }
  mouseMotionRipple.strength = Math.max(
    0,
    mouseMotionRipple.strength - MOUSE_RIPPLE_DECAY_PER_SEC * dtSec,
  );
  mouseMotionRipple.phase += dtSec * (3.1 + mouseMotionRipple.strength * 4.6);
}

function pushTrailPoint(b: BallState): void {
  trail.push({ x: b.x + BALL / 2, y: b.y + BALL / 2, life: TRAIL_LIFE_SEC });
  if (trail.length > MAX_TRAIL_POINTS) {
    trail.splice(0, trail.length - MAX_TRAIL_POINTS);
  }
}

function applyClockSample(serverTimeMs: number): void {
  const sample = serverTimeMs - Date.now();
  if (clockSamples.length >= 20) clockSamples.shift();
  clockSamples.push(sample);
  const sorted = [...clockSamples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? sample;
  if (Math.abs(sample - median) > CLOCK_OUTLIER_MS) return;
  if (clockOffsetMs === null) {
    clockOffsetMs = sample;
  } else {
    clockOffsetMs += CLOCK_EMA_ALPHA * (sample - clockOffsetMs);
  }
}

function getLeftInput(): PaddleInput {
  return local.side === "left" ? local.input : remoteLeftInput;
}

function getRightInput(): PaddleInput {
  return local.side === "right" ? local.input : remoteRightInput;
}

/** Forward ball along vx/vy with top/bottom elastic walls only (matches zero-gravity server). */
function simulateBallWallOnly(
  start: BallState,
  durationSec: number,
): BallState {
  const b = { ...start };
  const STEP = 1 / 240;
  let left = durationSec;
  let guard = 0;
  while (left > 1e-9 && guard++ < 4096) {
    const dt = Math.min(STEP, left);
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.y < 0) {
      b.y = -b.y;
      b.vy = -b.vy;
    } else if (b.y > FIELD_H - BALL) {
      b.y = 2 * (FIELD_H - BALL) - b.y;
      b.vy = -b.vy;
    }
    left -= dt;
  }
  return b;
}

function integrateBallOneStep(b: BallState, dt: number): void {
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  if (b.y < 0) {
    b.y = -b.y;
    b.vy = -b.vy;
  } else if (b.y > FIELD_H - BALL) {
    b.y = 2 * (FIELD_H - BALL) - b.y;
    b.vy = -b.vy;
  }
}

function applyBallEvent(
  msg: Extract<ServerMessage, { type: "ballEvent" }>,
): void {
  if (msg.sequence <= lastServerSequence) return;
  lastServerSequence = msg.sequence;
  applyClockSample(msg.serverTimeMs);

  const estimatedServerNow = Date.now() + (clockOffsetMs ?? 0);
  const lagMs = Math.max(0, estimatedServerNow - msg.serverTimeMs);
  const corrected = simulateBallWallOnly(
    {
      x: msg.ball.x,
      y: msg.ball.y,
      vx: msg.ball.vx,
      vy: msg.ball.vy,
    },
    lagMs / 1000,
  );
  const eventBall: BallState = {
    x: msg.ball.x,
    y: msg.ball.y,
    vx: msg.ball.vx,
    vy: msg.ball.vy,
  };
  if (ball) {
    const dx = corrected.x - ball.x;
    const dy = corrected.y - ball.y;
    const err = Math.hypot(dx, dy);
    metrics.correctionPx.push(err);
    if (err > 0) metrics.correctionCount += 1;
    if (err > LARGE_CORRECTION_PX) {
      ball = corrected;
      metrics.correctionSnapCount += 1;
    } else if (err > SMALL_CORRECTION_PX) {
      ball = {
        x: ball.x + dx * 0.35,
        y: ball.y + dy * 0.35,
        vx: corrected.vx,
        vy: corrected.vy,
      };
    } else {
      // Always apply authoritative velocity so paddle-hit direction changes are visible immediately.
      ball = {
        x: ball.x + dx * 0.1,
        y: ball.y + dy * 0.1,
        vx: corrected.vx,
        vy: corrected.vy,
      };
    }
  } else {
    ball = corrected;
  }
  authoritativeBallSnapshots.push({
    sequence: msg.sequence,
    serverTimeMs: msg.serverTimeMs,
    ball: corrected,
  });
  if (authoritativeBallSnapshots.length > MAX_SNAPSHOTS) {
    authoritativeBallSnapshots.splice(
      0,
      authoritativeBallSnapshots.length - MAX_SNAPSHOTS,
    );
  }
  leftScore = msg.leftScore;
  rightScore = msg.rightScore;
  if (msg.reason === "wallBounce") {
    emitWallBounceFx(eventBall);
    emitBounceRippleFx(eventBall, "wallBounce");
  } else if (msg.reason === "paddleHit") {
    emitPaddleBounceFx(eventBall);
    emitBounceRippleFx(eventBall, "paddleHit");
  } else {
    resetVisualFx();
  }
  sounds.playBall(msg.reason);
}

function applyInputEvent(
  msg: Extract<ServerMessage, { type: "inputEvent" }>,
): void {
  if (msg.sequence <= lastServerSequence) return;
  lastServerSequence = msg.sequence;
  applyClockSample(msg.serverTimeMs);

  if (msg.side === local.side) return;
  if (msg.side === "left") remoteLeftInput = msg.input;
  else remoteRightInput = msg.input;
}

function applyGameStart(
  msg: Extract<ServerMessage, { type: "gameStart" }>,
): void {
  clearMatchResultOverlay();
  stopCountdownInputFlush();
  lastServerSequence = msg.sequence;
  applyClockSample(msg.serverTimeMs);
  const s = msg.state;
  ball = {
    x: s.ball.x,
    y: s.ball.y,
    vx: s.ball.vx,
    vy: s.ball.vy,
  };
  leftY = s.leftY;
  rightY = s.rightY;
  leftScore = s.leftScore;
  rightScore = s.rightScore;
  running = s.running;
  remoteLeftInput = 0;
  remoteRightInput = 0;
  resetVisualFx();
  local.phase = "running";
  ui.countdownTargetMs = 0;
  sounds.playGameGo();
}

const VERTEX_SHADER_SOURCE = `
attribute vec2 aPosition;
uniform vec2 uResolution;
void main() {
  vec2 zeroToOne = aPosition / uResolution;
  vec2 zeroToTwo = zeroToOne * 2.0;
  vec2 clipSpace = zeroToTwo - 1.0;
  gl_Position = vec4(clipSpace * vec2(1.0, -1.0), 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SOURCE = `
precision mediump float;
uniform vec4 uColor;
void main() {
  gl_FragColor = uColor;
}
`;

const POST_VERTEX_SHADER_SOURCE = `
attribute vec2 aClipPos;
varying vec2 vUv;
void main() {
  vUv = (aClipPos + 1.0) * 0.5;
  gl_Position = vec4(aClipPos, 0.0, 1.0);
}
`;

const POST_FRAGMENT_SHADER_SOURCE = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSceneTex;
uniform float uTimeSec;
uniform float uLobbyMix;
uniform vec2 uMouseUv;
uniform vec2 uMouseRippleCenter;
uniform float uMouseRippleStrength;
uniform float uMouseRipplePhase;
uniform int uRippleCount;
uniform int uLobbyTraceCount;
uniform vec4 uRippleData[${MAX_RIPPLES}];
uniform vec4 uRippleParams[${MAX_RIPPLES}];
uniform vec4 uLobbyTraceData[${MAX_LOBBY_TRACE_POINTS}];

void main() {
  vec2 uv = vUv;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    if (i >= uRippleCount) {
      continue;
    }
    vec4 data = uRippleData[i];
    vec4 params = uRippleParams[i];
    float ageSec = uTimeSec - data.z;
    float durationSec = data.w;
    if (ageSec < 0.0 || ageSec >= durationSec) {
      continue;
    }
    vec2 center = data.xy;
    vec2 delta = uv - center;
    float dist = length(delta);
    if (dist <= 0.0001) {
      continue;
    }
    float wave = sin(dist * params.y - ageSec * params.z);
    float life = 1.0 - ageSec / durationSec;
    float envelope = exp(-params.w * dist) * life;
    float offset = params.x * wave * envelope;
    uv += normalize(delta) * offset;
  }
  uv = clamp(uv, 0.001, 0.999);
  float ambientWaveA = sin((uv.x + uTimeSec * 0.026) * 12.0 + cos(uTimeSec * 0.08) * 0.6);
  float ambientWaveB = cos((uv.y - uTimeSec * 0.021) * 10.0 + sin(uTimeSec * 0.11) * 0.6);
  float ambientField = ambientWaveA * ambientWaveB;
  vec2 centered = (uv - 0.5) * vec2(1.12, 1.0);
  float vignette = smoothstep(0.92, 0.14, length(centered));
  vec3 ambientTint = vec3(0.055, 0.09, 0.16) * (0.45 + 0.55 * vignette);
  ambientTint += vec3(0.045, 0.02, 0.09) * (0.5 + 0.5 * ambientField);

  float mouseDist = length(uv - uMouseUv);
  float mouseCore = exp(-mouseDist * 26.0);
  float mouseHalo = exp(-mouseDist * 9.0) * 0.55;
  vec2 rippleDelta = uv - uMouseRippleCenter;
  float rippleDist = length(rippleDelta);
  float rippleWavePrimary = sin(rippleDist * 62.0 - uMouseRipplePhase * 3.0);
  float rippleWaveSecondary = sin(rippleDist * 34.0 - uMouseRipplePhase * 1.7 + 1.2);
  float swirl = sin((rippleDelta.x * 13.0 - rippleDelta.y * 11.0) + uTimeSec * 0.7);
  float rippleWave = rippleWavePrimary * 0.72 + rippleWaveSecondary * 0.38 + swirl * 0.16;
  float rippleEnvelope = exp(-rippleDist * (8.2 + uMouseRippleStrength * 3.2));
  float mouseRipple = rippleWave * rippleEnvelope * uMouseRippleStrength;
  vec2 rippleDir = rippleDist > 0.0001 ? normalize(rippleDelta) : vec2(0.0, 0.0);
  vec2 tangent = vec2(-rippleDir.y, rippleDir.x);
  float radialDisp = mouseRipple * (0.024 + uMouseRippleStrength * 0.02);
  float swirlDisp = rippleEnvelope * sin(uMouseRipplePhase * 1.25 - rippleDist * 40.0) * 0.007;
  vec2 lobbyDeform = (rippleDir * radialDisp + tangent * swirlDisp) * uLobbyMix;
  vec2 deformedUv = clamp(uv + lobbyDeform, 0.001, 0.999);
  vec4 base = texture2D(uSceneTex, deformedUv);
  vec3 color = base.rgb;

  float traceGlow = 0.0;
  for (int i = 0; i < ${MAX_LOBBY_TRACE_POINTS}; i++) {
    if (i >= uLobbyTraceCount) {
      continue;
    }
    vec4 traceData = uLobbyTraceData[i];
    float life = traceData.z;
    if (life <= 0.0) {
      continue;
    }
    float traceDist = length(uv - traceData.xy);
    float falloff = exp(-traceDist * (38.0 - life * 18.0));
    traceGlow += traceData.w * life * falloff;
  }

  vec3 lobbyColor = color;
  lobbyColor += ambientTint * 0.16;
  lobbyColor += vec3(0.30, 0.46, 0.90) * mouseCore * 0.11;
  lobbyColor += vec3(0.44, 0.24, 0.76) * mouseHalo * 0.07;
  lobbyColor += vec3(0.56, 0.74, 1.0) * max(0.0, mouseRipple) * 0.10;
  lobbyColor -= vec3(0.08, 0.12, 0.20) * min(0.0, mouseRipple) * 0.05;
  lobbyColor += vec3(0.55, 0.76, 1.0) * traceGlow * 0.085;
  lobbyColor = clamp(lobbyColor, 0.0, 1.0);

  gl_FragColor = vec4(mix(color, lobbyColor, clamp(uLobbyMix, 0.0, 1.0)), base.a);
}
`;

const MAX_RECTS = 8192;
const VERTICES_PER_RECT = 6;
const COMPONENTS_PER_VERTEX = 2;
const maxFloatCount = MAX_RECTS * VERTICES_PER_RECT * COMPONENTS_PER_VERTEX;
const vertexData = new Float32Array(maxFloatCount);
let vertexCount = 0;

function compileShader(type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("failed to create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) ?? "unknown shader compile error";
    gl.deleteShader(shader);
    throw new Error(info);
  }
  return shader;
}

function createProgram(vertexSource: string, fragmentSource: string): WebGLProgram {
  const vertexShader = compileShader(gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error("failed to create shader program");
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) ?? "unknown program link error";
    gl.deleteProgram(program);
    throw new Error(info);
  }
  return program;
}

const program = createProgram(VERTEX_SHADER_SOURCE, FRAGMENT_SHADER_SOURCE);
const positionLoc = gl.getAttribLocation(program, "aPosition");
if (positionLoc < 0) throw new Error("aPosition attribute not found");
const resolutionLoc = gl.getUniformLocation(program, "uResolution");
if (resolutionLoc === null) throw new Error("uResolution uniform not found");
const colorLoc = gl.getUniformLocation(program, "uColor");
if (colorLoc === null) throw new Error("uColor uniform not found");

const vertexBuffer = gl.createBuffer();
if (!vertexBuffer) throw new Error("failed to create vertex buffer");
gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
gl.bufferData(gl.ARRAY_BUFFER, vertexData.byteLength, gl.DYNAMIC_DRAW);
gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

const postProgram = createProgram(POST_VERTEX_SHADER_SOURCE, POST_FRAGMENT_SHADER_SOURCE);
const postPositionLoc = gl.getAttribLocation(postProgram, "aClipPos");
if (postPositionLoc < 0) throw new Error("aClipPos attribute not found");
const postSceneTexLoc = gl.getUniformLocation(postProgram, "uSceneTex");
if (postSceneTexLoc === null) throw new Error("uSceneTex uniform not found");
const postTimeLoc = gl.getUniformLocation(postProgram, "uTimeSec");
if (postTimeLoc === null) throw new Error("uTimeSec uniform not found");
const postLobbyMixLoc = gl.getUniformLocation(postProgram, "uLobbyMix");
if (postLobbyMixLoc === null) throw new Error("uLobbyMix uniform not found");
const postMouseUvLoc = gl.getUniformLocation(postProgram, "uMouseUv");
if (postMouseUvLoc === null) throw new Error("uMouseUv uniform not found");
const postMouseRippleCenterLoc = gl.getUniformLocation(postProgram, "uMouseRippleCenter");
if (postMouseRippleCenterLoc === null) throw new Error("uMouseRippleCenter uniform not found");
const postMouseRippleStrengthLoc = gl.getUniformLocation(postProgram, "uMouseRippleStrength");
if (postMouseRippleStrengthLoc === null) throw new Error("uMouseRippleStrength uniform not found");
const postMouseRipplePhaseLoc = gl.getUniformLocation(postProgram, "uMouseRipplePhase");
if (postMouseRipplePhaseLoc === null) throw new Error("uMouseRipplePhase uniform not found");
const postRippleCountLoc = gl.getUniformLocation(postProgram, "uRippleCount");
if (postRippleCountLoc === null) throw new Error("uRippleCount uniform not found");
const postLobbyTraceCountLoc = gl.getUniformLocation(postProgram, "uLobbyTraceCount");
if (postLobbyTraceCountLoc === null) throw new Error("uLobbyTraceCount uniform not found");
const postRippleDataLoc = gl.getUniformLocation(postProgram, "uRippleData[0]");
if (postRippleDataLoc === null) throw new Error("uRippleData uniform not found");
const postRippleParamsLoc = gl.getUniformLocation(postProgram, "uRippleParams[0]");
if (postRippleParamsLoc === null) throw new Error("uRippleParams uniform not found");
const postLobbyTraceDataLoc = gl.getUniformLocation(postProgram, "uLobbyTraceData[0]");
if (postLobbyTraceDataLoc === null) throw new Error("uLobbyTraceData uniform not found");

const postQuadBuffer = gl.createBuffer();
if (!postQuadBuffer) throw new Error("failed to create post-process quad buffer");
gl.bindBuffer(gl.ARRAY_BUFFER, postQuadBuffer);
gl.bufferData(
  gl.ARRAY_BUFFER,
  new Float32Array([
    -1, -1,
    1, -1,
    -1, 1,
    -1, 1,
    1, -1,
    1, 1,
  ]),
  gl.STATIC_DRAW,
);

type SceneRenderTarget = {
  framebuffer: NonNullable<ReturnType<WebGLRenderingContext["createFramebuffer"]>>;
  texture: NonNullable<ReturnType<WebGLRenderingContext["createTexture"]>>;
};

function createSceneRenderTarget(): SceneRenderTarget {
  const texture = gl.createTexture();
  if (!texture) throw new Error("failed to create scene texture");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null as unknown as ArrayBufferView<ArrayBufferLike>,
  );

  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) throw new Error("failed to create scene framebuffer");
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`incomplete scene framebuffer: ${status}`);
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null as unknown as SceneRenderTarget["framebuffer"]);
  gl.bindTexture(gl.TEXTURE_2D, null as unknown as SceneRenderTarget["texture"]);
  return { framebuffer, texture };
}

const sceneRenderTarget = createSceneRenderTarget();
const rippleDataBuffer = new Float32Array(MAX_RIPPLES * 4);
const rippleParamsBuffer = new Float32Array(MAX_RIPPLES * 4);
const lobbyTraceDataBuffer = new Float32Array(MAX_LOBBY_TRACE_POINTS * 4);

function useSceneProgram(): void {
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.enableVertexAttribArray(positionLoc);
  gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
}

function renderPostProcess(nowMs: number): void {
  for (let i = 0; i < MAX_RIPPLES; i++) {
    const pulse = ripplePulses[i];
    const o = i * 4;
    if (pulse) {
      rippleDataBuffer[o] = pulse.x;
      rippleDataBuffer[o + 1] = pulse.y;
      rippleDataBuffer[o + 2] = pulse.startMs / 1000;
      rippleDataBuffer[o + 3] = pulse.durationMs / 1000;
      rippleParamsBuffer[o] = pulse.amplitude;
      rippleParamsBuffer[o + 1] = pulse.frequency;
      rippleParamsBuffer[o + 2] = pulse.speed;
      rippleParamsBuffer[o + 3] = pulse.damping;
    } else {
      rippleDataBuffer[o] = 0;
      rippleDataBuffer[o + 1] = 0;
      rippleDataBuffer[o + 2] = 0;
      rippleDataBuffer[o + 3] = 0;
      rippleParamsBuffer[o] = 0;
      rippleParamsBuffer[o + 1] = 0;
      rippleParamsBuffer[o + 2] = 0;
      rippleParamsBuffer[o + 3] = 0;
    }
  }
  for (let i = 0; i < MAX_LOBBY_TRACE_POINTS; i++) {
    const trace = lobbyTracePoints[i];
    const o = i * 4;
    if (trace) {
      lobbyTraceDataBuffer[o] = trace.x;
      lobbyTraceDataBuffer[o + 1] = trace.y;
      lobbyTraceDataBuffer[o + 2] = clamp(trace.life / trace.maxLife, 0, 1);
      lobbyTraceDataBuffer[o + 3] = trace.strength;
    } else {
      lobbyTraceDataBuffer[o] = 0;
      lobbyTraceDataBuffer[o + 1] = 0;
      lobbyTraceDataBuffer[o + 2] = 0;
      lobbyTraceDataBuffer[o + 3] = 0;
    }
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null as unknown as SceneRenderTarget["framebuffer"]);
  gl.viewport(0, 0, width, height);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(postProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, postQuadBuffer);
  gl.enableVertexAttribArray(postPositionLoc);
  gl.vertexAttribPointer(postPositionLoc, 2, gl.FLOAT, false, 0, 0);
  gl.uniform1i(postSceneTexLoc, 0);
  gl.uniform1f(postTimeLoc, nowMs / 1000);
  gl.uniform1f(postLobbyMixLoc, isLobbyPostFxActive() ? 1 : 0);
  const playHeight = Math.max(1, height - STATUS_BAR_H);
  const mouseUvX = clamp(ui.mouseX, 0, width) / width;
  const mouseUvY = 1 - clamp(ui.mouseY, 0, playHeight) / height;
  gl.uniform2f(postMouseUvLoc, mouseUvX, mouseUvY);
  const rippleStrength = isLobbyPostFxActive() ? mouseMotionRipple.strength : 0;
  gl.uniform2f(postMouseRippleCenterLoc, mouseMotionRipple.centerX, mouseMotionRipple.centerY);
  gl.uniform1f(postMouseRippleStrengthLoc, clamp(rippleStrength, 0, 1));
  gl.uniform1f(postMouseRipplePhaseLoc, mouseMotionRipple.phase);
  gl.uniform1i(postRippleCountLoc, ripplePulses.length);
  gl.uniform1i(postLobbyTraceCountLoc, lobbyTracePoints.length);
  gl.uniform4fv(postRippleDataLoc, rippleDataBuffer);
  gl.uniform4fv(postRippleParamsLoc, rippleParamsBuffer);
  gl.uniform4fv(postLobbyTraceDataLoc, lobbyTraceDataBuffer);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, sceneRenderTarget.texture);

  gl.disable(gl.BLEND);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.enable(gl.BLEND);
}

function beginBatch(): void {
  vertexCount = 0;
}

function pushRect(x: number, y: number, w: number, h: number): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(width, Math.ceil(x + w));
  const y1 = Math.min(height, Math.ceil(y + h));
  if (x1 <= x0 || y1 <= y0) return;

  const needed = VERTICES_PER_RECT * COMPONENTS_PER_VERTEX;
  if (vertexCount + needed > vertexData.length) {
    throw new Error("rectangle batch overflow");
  }

  vertexData[vertexCount++] = x0;
  vertexData[vertexCount++] = y0;
  vertexData[vertexCount++] = x1;
  vertexData[vertexCount++] = y0;
  vertexData[vertexCount++] = x0;
  vertexData[vertexCount++] = y1;

  vertexData[vertexCount++] = x0;
  vertexData[vertexCount++] = y1;
  vertexData[vertexCount++] = x1;
  vertexData[vertexCount++] = y0;
  vertexData[vertexCount++] = x1;
  vertexData[vertexCount++] = y1;
}

function pushEllipse(x: number, y: number, w: number, h: number): void {
  const cx = x + w * 0.5;
  const rx = Math.max(1, w * 0.5);
  const ry = Math.max(1, h * 0.5);
  const rowCount = Math.max(6, Math.ceil(h));
  const rowHeight = h / rowCount;

  for (let row = 0; row < rowCount; row++) {
    const rowCenter = y + (row + 0.5) * rowHeight;
    const normalizedY = (rowCenter - (y + ry)) / ry;
    const radial = 1 - normalizedY * normalizedY;
    if (radial <= 0) continue;
    const halfWidth = rx * Math.sqrt(radial);
    pushRect(cx - halfWidth, y + row * rowHeight, halfWidth * 2, rowHeight + 0.8);
  }
}

function flushBatch(r: number, g: number, b: number, a: number): void {
  if (vertexCount === 0) return;
  gl.uniform4f(colorLoc, r, g, b, a);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertexData.subarray(0, vertexCount));
  gl.drawArrays(gl.TRIANGLES, 0, vertexCount / 2);
  vertexCount = 0;
}

function sendCreateRoom(): void {
  connection.sendReliable(
    CHANNEL_EVENT,
    encodeMessage({ type: "createRoom", name, version: PING_PONG_PROTOCOL_VERSION }),
    true,
  );
}

function sendJoinRoom(roomId?: string): void {
  connection.sendReliable(
    CHANNEL_EVENT,
    encodeMessage({
      type: "joinRoom",
      roomId,
      name,
      version: PING_PONG_PROTOCOL_VERSION,
    }),
    true,
  );
}

function clearBootstrapTimer(): void {
  if (bootstrapTimer === null) return;
  clearInterval(bootstrapTimer);
  bootstrapTimer = null;
}

function stopCountdownInputFlush(): void {
  if (countdownInputFlushTimer === null) return;
  clearInterval(countdownInputFlushTimer);
  countdownInputFlushTimer = null;
}

function stopAllPeriodicTimers(): void {
  clearBootstrapTimer();
  stopCountdownInputFlush();
  for (const t of [
    pendingWatchTimer,
    heartbeatTimer,
    simulationTimer,
    renderTimer,
    metricsLogTimer,
  ]) {
    if (t !== null) clearInterval(t);
  }
  pendingWatchTimer = null;
  heartbeatTimer = null;
  simulationTimer = null;
  renderTimer = null;
  metricsLogTimer = null;
}

/** Idempotent shutdown: avoids duplicate UDP sends when SDL teardown re-emits `close` after quit. */
function gracefulExit(exitCode: number, notifyServerQuit: boolean): void {
  if (shuttingDown) return;
  shuttingDown = true;

  sounds.close();
  stopAllPeriodicTimers();

  if (notifyServerQuit) {
    try {
      connection.sendReliable(CHANNEL_EVENT, encodeMessage({ type: "quit" }), true);
    } catch {
      // Socket already closed during nested SDL teardown.
    }
  }

  try {
    socket.close();
  } catch {
    // Duplicate close during exit.
  }

  process.exit(exitCode);
}

function startCountdownInputFlush(): void {
  stopCountdownInputFlush();
  countdownInputFlushTimer = setInterval(() => {
    if (local.phase !== "starting") {
      stopCountdownInputFlush();
      return;
    }
    sendInput(effectiveMovementInput(), { force: true });
  }, COUNTDOWN_INPUT_FLUSH_MS);
}

function markServerReachable(): void {
  if (serverReachable) return;
  serverReachable = true;
  clearBootstrapTimer();
}

function bootstrapWaitingStatus(): string {
  if (roomAction === "create") return "Waiting for server... create room when ready";
  if (roomAction === "join" && requestedRoomId) {
    return `Waiting for server... join ${requestedRoomId} when ready`;
  }
  return "Waiting for server... retrying";
}

function dispatchStartupActionIfNeeded(): void {
  if (startupActionDispatched || !serverReachable) return;
  startupActionDispatched = true;
  if (roomAction === "create") {
    ui.statusText = "Creating room...";
    sendCreateRoom();
    return;
  }
  if (roomAction === "join" && requestedRoomId) {
    ui.statusText = `Joining ${requestedRoomId}...`;
    sendJoinRoom(requestedRoomId || undefined);
  }
}

function startBootstrapLoop(): void {
  const attemptBootstrap = () => {
    if (shuttingDown || serverReachable) return;
    ui.statusText = bootstrapWaitingStatus();
    connection.sendReliable(CHANNEL_EVENT, encodeMessage({ type: "listRooms" }), true);
  };
  attemptBootstrap();
  bootstrapTimer = setInterval(attemptBootstrap, BOOTSTRAP_RETRY_MS);
}

function setIdleState(message: string): void {
  stopCountdownInputFlush();
  lastServerSequence = -1;
  local.side = null;
  local.role = null;
  local.roomId = null;
  local.phase = "lobby";
  running = false;
  local.input = 0;
  ui.resultVisible = false;
  ui.resultWinner = null;
  ui.resultKind = null;
  ui.resultDismissAtMs = 0;
  ui.statusText = message;
  ui.countdownTargetMs = 0;
  ui.pendingFinish = null;
}

function getCountdownSecondsRemaining(): number {
  if (!ui.countdownTargetMs || local.phase !== "starting") return 0;
  const remainingMs = ui.countdownTargetMs - Date.now();
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

function getStartingOverlayText(): string | null {
  if (local.phase !== "starting") return null;
  const seconds = getCountdownSecondsRemaining();
  return `${seconds}`;
}

function getUiStatusText(): string {
  return ui.statusText;
}

function getLobbyLayout(playHeight: number): LobbyLayout {
  const panelX = Math.floor(width / 2 - UI_PANEL_W / 2);
  const panelY = Math.floor(playHeight / 2 - UI_PANEL_H / 2);
  return {
    panelX,
    panelY,
    headerY: panelY + 12,
    statusY: panelY + 34,
    buttonsY: panelY + 60,
    listY: panelY + 130,
    listRowH: 24,
    listRowGap: 8,
    listRows: 5,
    footerY: panelY + UI_PANEL_H - 24,
  };
}

function getUiButtons(playHeight: number): UiButton[] {
  const layout = getLobbyLayout(playHeight);
  const canJoin = local.phase !== "running";
  const canCreate = local.phase !== "running";
  const canLeave = !!local.roomId && local.phase !== "running";
  // Match server behavior: room auto-starts when second player joins.
  const canStart = false;
  const canQuit = true;
  return [
    {
      id: "create",
      x: layout.panelX + 16,
      y: layout.buttonsY,
      w: UI_BUTTON_W,
      h: UI_BUTTON_H,
      enabled: canCreate,
    },
    {
      id: "refresh",
      x: layout.panelX + 16 + UI_BUTTON_W + UI_GAP,
      y: layout.buttonsY,
      w: UI_BUTTON_W,
      h: UI_BUTTON_H,
      enabled: canJoin,
    },
    {
      id: "leave",
      x: layout.panelX + 16 + (UI_BUTTON_W + UI_GAP) * 2,
      y: layout.buttonsY,
      w: UI_BUTTON_W,
      h: UI_BUTTON_H,
      enabled: canLeave,
    },
    {
      id: "start",
      x: layout.panelX + 16 + (UI_BUTTON_W + UI_GAP) * 3,
      y: layout.buttonsY,
      w: UI_BUTTON_W,
      h: UI_BUTTON_H,
      enabled: canStart,
    },
    {
      id: "quit",
      x: layout.panelX + UI_PANEL_W - UI_BUTTON_W - 16,
      y: layout.footerY - 2,
      w: UI_BUTTON_W,
      h: UI_BUTTON_H,
      enabled: canQuit,
    },
  ];
}

function hitButton(buttons: UiButton[], x: number, y: number): UiButton | null {
  for (const b of buttons) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
  }
  return null;
}

function getRoomRowAt(x: number, y: number, playHeight: number): RoomSummary | null {
  const layout = getLobbyLayout(playHeight);
  const rowX = layout.panelX + 16;
  const rowY0 = layout.listY;
  const rowW = UI_PANEL_W - 32;
  const rowH = layout.listRowH;
  for (let i = 0; i < Math.min(layout.listRows, ui.rooms.length); i++) {
    const ry = rowY0 + i * (rowH + layout.listRowGap);
    if (x >= rowX && x <= rowX + rowW && y >= ry && y <= ry + rowH) {
      return ui.rooms[i] ?? null;
    }
  }
  return null;
}

function drawText(
  text: string,
  x: number,
  y: number,
  scale: number,
  color: [number, number, number, number],
): void {
  const up = text.toUpperCase();
  beginBatch();
  let cursorX = x;
  for (let i = 0; i < up.length; i++) {
    const ch = up[i] ?? " ";
    const glyph = FONT_3X5[ch] ?? FONT_3X5[" "];
    if (!glyph) continue;
    for (let row = 0; row < glyph.length; row++) {
      const rowData = glyph[row] ?? "000";
      for (let col = 0; col < rowData.length; col++) {
        if (rowData[col] === "1") {
          pushRect(cursorX + col * scale, y + row * scale, scale, scale);
        }
      }
    }
    cursorX += 4 * scale;
  }
  flushBatch(color[0], color[1], color[2], color[3]);
}

/** Hide VICTORY/DEFEAT overlay without leaving the room (unlike dismissResultModal). */
function clearMatchResultOverlay(): void {
  ui.resultVisible = false;
  ui.resultWinner = null;
  ui.resultKind = null;
  ui.resultDismissAtMs = 0;
}

function dismissResultModal(): void {
  if (!ui.resultVisible) return;
  clearMatchResultOverlay();
  stopCountdownInputFlush();
  ui.pendingFinish = null;
  if (local.roomId) {
    connection.sendReliable(CHANNEL_EVENT, encodeMessage({ type: "leaveRoom" }), true);
  }
  connection.sendReliable(CHANNEL_EVENT, encodeMessage({ type: "listRooms" }), true);
  local.phase = "lobby";
  running = false;
}

function applyFinishResult(
  roomId: string,
  winner: "left" | "right",
  leftScore: number,
  rightScore: number,
): void {
  if (local.roomId && local.roomId !== roomId) return;
  if (!local.side || local.roomId !== roomId) {
    ui.pendingFinish = { roomId, winner, leftScore, rightScore };
    return;
  }
  running = false;
  local.phase = "finished";
  ui.resultVisible = true;
  ui.resultWinner = winner;
  ui.resultKind = local.side === winner ? "win" : "lose";
  ui.resultDismissAtMs = performance.now() + 5000;
  const yourScore = local.side === "left" ? leftScore : rightScore;
  const opponentScore = local.side === "left" ? rightScore : leftScore;
  ui.statusText =
    ui.resultKind === "win" ? `Won ${yourScore}:${opponentScore}` : `Lost ${yourScore}:${opponentScore}`;
  ui.pendingFinish = null;
}

function setPendingAction(label: string): void {
  ui.pendingAction = label;
  ui.pendingActionUntilMs = performance.now() + 3000;
}

function clearPendingAction(): void {
  ui.pendingAction = null;
  ui.pendingActionUntilMs = 0;
}

function applyRoomServerMessage(msg: ServerMessage): void {
  if (msg.type === "roomCreated" || msg.type === "roomJoined") {
    clearMatchResultOverlay();
    if (ui.pendingFinish && ui.pendingFinish.roomId !== msg.roomId) {
      ui.pendingFinish = null;
    }
    if (local.roomId !== msg.roomId) {
      lastServerSequence = -1;
    }
    local.side = msg.side;
    local.role = msg.role;
    local.roomId = msg.roomId;
    local.phase = "waiting";
    ui.errorText = "";
    ui.statusText =
      msg.connected >= 2
        ? `Room ${msg.roomId} ready (${msg.role})`
        : `Room ${msg.roomId} waiting (${msg.connected}/2)`;
    ui.countdownTargetMs = 0;
    clearPendingAction();
    return;
  }
  if (msg.type === "roomWaiting") {
    if (ui.pendingFinish && ui.pendingFinish.roomId !== msg.roomId) {
      ui.pendingFinish = null;
    }
    if (local.roomId !== msg.roomId) {
      lastServerSequence = -1;
    }
    local.roomId = msg.roomId;
    local.phase = "waiting";
    ui.statusText =
      msg.connected >= 2
        ? `Room ${msg.roomId} full, auto-starting...`
        : `Room ${msg.roomId} waiting (${msg.connected}/2)`;
    ui.countdownTargetMs = 0;
    return;
  }
  if (msg.type === "playerAssigned") {
    local.side = msg.side;
    return;
  }
  if (msg.type === "lobbyState") {
    ui.rooms = msg.rooms;
    const nextRoomId = msg.you.roomId ?? null;
    if (local.roomId !== nextRoomId) {
      lastServerSequence = -1;
    }
    local.roomId = nextRoomId;
    if (!nextRoomId) {
      local.role = null;
      local.side = null;
    } else {
      if (msg.you.role !== undefined) local.role = msg.you.role;
      if (msg.you.side !== undefined) local.side = msg.you.side;
    }
    if (ui.pendingFinish) {
      if (local.roomId && local.roomId !== ui.pendingFinish.roomId) {
        ui.pendingFinish = null;
      } else if (local.side) {
        applyFinishResult(
          ui.pendingFinish.roomId,
          ui.pendingFinish.winner,
          ui.pendingFinish.leftScore,
          ui.pendingFinish.rightScore,
        );
      }
    }
    if (
      local.phase !== "running" &&
      local.phase !== "starting" &&
      local.phase !== "error" &&
      local.phase !== "finished"
    ) {
      local.phase = local.roomId ? "waiting" : "lobby";
    }
    if (!local.roomId) ui.countdownTargetMs = 0;
    if (!(local.phase === "finished" && ui.resultVisible)) {
      ui.statusText = local.roomId
        ? `In room ${local.roomId} (${local.role ?? "-"})`
        : "Lobby ready";
    }
    clearPendingAction();
    return;
  }
  if (msg.type === "roomState") {
    if (!local.roomId || msg.state.roomId !== local.roomId) return;
    leftScore = msg.state.leftScore;
    rightScore = msg.state.rightScore;
    running = msg.state.running;

    if (msg.state.phase === "starting") {
      clearMatchResultOverlay();
      local.phase = "starting";
      if (typeof msg.state.startedAtMs === "number") {
        ui.countdownTargetMs = msg.state.startedAtMs;
      }
      leftY = FIELD_H / 2 - PADDLE_H / 2;
      rightY = FIELD_H / 2 - PADDLE_H / 2;
      remoteLeftInput = 0;
      remoteRightInput = 0;
      local.input = 0;
      ball = { x: FIELD_W / 2, y: FIELD_H / 2, vx: 0, vy: 0 };
      resetVisualFx();
      applyMovementInput();
      sendInput(effectiveMovementInput(), { force: true });
      startCountdownInputFlush();
    } else {
      stopCountdownInputFlush();
      if (msg.state.phase !== "running") {
        local.phase = "waiting";
        ui.countdownTargetMs = 0;
      }
    }
    return;
  }
  if (msg.type === "roomStarted") {
    ui.statusText = `Room ${msg.roomId} started`;
    return;
  }
  if (msg.type === "roomFinished") {
    if (local.roomId && msg.roomId !== local.roomId) return;
    applyFinishResult(msg.roomId, msg.winner, msg.leftScore, msg.rightScore);
    return;
  }
  if (msg.type === "roomLeft") {
    setIdleState(`Left room ${msg.roomId}`);
    clearPendingAction();
    return;
  }
  if (msg.type === "roomDeleted") {
    if (
      local.phase === "finished" &&
      ui.resultVisible &&
      local.roomId === msg.roomId
    ) {
      stopCountdownInputFlush();
      lastServerSequence = -1;
      local.roomId = null;
      local.role = null;
      local.side = null;
      running = false;
      local.input = 0;
      ui.countdownTargetMs = 0;
      ui.pendingFinish = null;
      clearPendingAction();
      connection.sendReliable(CHANNEL_EVENT, encodeMessage({ type: "listRooms" }), true);
      return;
    }
    setIdleState(`Room ${msg.roomId} deleted`);
    clearPendingAction();
    return;
  }
  if (msg.type === "roomError") {
    local.phase = "error";
    ui.errorText = `${msg.code}: ${msg.message}`;
    ui.statusText = `Error: ${msg.code}`;
    clearPendingAction();
    return;
  }
}

function draw(): void {
  if (ui.resultVisible && performance.now() >= ui.resultDismissAtMs) {
    dismissResultModal();
  }
  const nowMs = performance.now();
  pruneRipplePulses(nowMs);
  if (!isLobbyPostFxActive() && lobbyTracePoints.length > 0) {
    clearLobbyTraceFx();
  }
  if (local.phase === "starting") {
    const sec = getCountdownSecondsRemaining();
    if (soundLastCountdownSec !== null && sec < soundLastCountdownSec) {
      sounds.playCountdownTick();
    }
    soundLastCountdownSec = sec;
  } else {
    soundLastCountdownSec = null;
  }
  const alpha = Math.min(1, Math.max(0, simulationAccumulatorMs / SIM_STEP_MS));
  const leftInput = getLeftInput();
  const rightInput = getRightInput();
  const renderLeft = leftY - leftInput * PADDLE_SPEED * (SIM_STEP_MS / 1000) * (1 - alpha);
  const renderRight =
    rightY - rightInput * PADDLE_SPEED * (SIM_STEP_MS / 1000) * (1 - alpha);
  const renderBall =
    running && ball
      ? simulateBallWallOnly(ball, (SIM_STEP_MS / 1000) * alpha)
      : ball;
  const playHeight = Math.max(1, height - STATUS_BAR_H);
  const sx = width / FIELD_W;
  const sy = playHeight / FIELD_H;
  const onField = running || local.phase === "starting";
  gl.bindFramebuffer(gl.FRAMEBUFFER, sceneRenderTarget.framebuffer);
  useSceneProgram();
  gl.viewport(0, 0, width, height);
  gl.uniform2f(resolutionLoc, width, height);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const pulsePhase = (Math.sin((nowMs / 1000) * Math.PI * 2 * BG_PULSE_HZ) + 1) * 0.5;
  const pulse = pulsePhase * pulsePhase * (3 - 2 * pulsePhase);

  beginBatch();
  pushRect(0, 0, width, playHeight);
  flushBatch(
    (16 + pulse * 16) / 255,
    (10 + pulse * 10) / 255,
    (30 + pulse * 28) / 255,
    1,
  );

  // Saturated procedural grain layer with constant-time global pulse.
  const noiseTick = nowMs * BG_NOISE_SPEED;
  for (let gy = 0; gy < playHeight; gy += BG_NOISE_CELL) {
    for (let gx = 0; gx < width; gx += BG_NOISE_CELL) {
      const n = noise2D((gx / BG_NOISE_CELL) | 0, (gy / BG_NOISE_CELL) | 0, noiseTick);
      const s = 0.44 + n * 0.24;
      const a = BG_NOISE_BLEND * (0.5 + 0.6 * pulse) * (0.82 + n * 0.18);
      beginBatch();
      pushRect(gx, gy, BG_NOISE_CELL + 1, BG_NOISE_CELL + 1);
      flushBatch(
        0.20 + s * (0.15 + pulse * 0.07),
        0.10 + s * (0.06 + pulse * 0.03),
        0.36 + s * (0.16 + pulse * 0.09),
        a,
      );
    }
  }

  beginBatch();
  pushRect(0, 0, width, playHeight);
  flushBatch(0.45, 0.14, 0.66, 0.035 + pulse * 0.05);

  if (onField) {
    beginBatch();
    for (let y = 0; y < playHeight; y += 16) {
      pushRect(width / 2 - 1, y, 2, 8);
    }
    flushBatch(70 / 255, 70 / 255, 70 / 255, 1);
  }

  if (renderBall && running) {
    pushTrailPoint(renderBall);

    if (trail.length > 0) {
      for (let i = 0; i < trail.length; i++) {
        const t = trail[i]!;
        const fade = clamp(t.life / TRAIL_LIFE_SEC, 0, 1);
        const soft = fade * fade;
        const size = (BALL * (0.92 + (1 - soft) * 0.78) + 4.2) * ((sx + sy) * 0.5);
        const alphaTrail = 0.012 + soft * 0.055;
        beginBatch();
        pushRect(
          t.x * sx - size / 2,
          t.y * sy - size / 2,
          size,
          size,
        );
        flushBatch(0.68, 0.90, 1.0, alphaTrail);
      }
    }

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i]!;
      const fade = clamp(p.life / p.maxLife, 0, 1);
      const size = p.size * (0.55 + 0.9 * fade) * ((sx + sy) * 0.5);
      beginBatch();
      pushRect(
        p.x * sx - size / 2,
        p.y * sy - size / 2,
        size,
        size,
      );
      flushBatch(p.r, p.g, p.b, fade * 0.95);
    }

    const leftMotion = Math.abs(leftInput);
    const rightMotion = Math.abs(rightInput);
    const leftGlowW = (PADDLE_W + 7 + leftMotion * 6) * sx;
    const rightGlowW = (PADDLE_W + 7 + rightMotion * 6) * sx;
    const leftGlowH = (PADDLE_H + 10 + leftMotion * 12) * sy;
    const rightGlowH = (PADDLE_H + 10 + rightMotion * 12) * sy;
    beginBatch();
    pushRect(
      PADDLE_X * sx - (leftGlowW - PADDLE_W * sx) / 2,
      renderLeft * sy - (leftGlowH - PADDLE_H * sy) / 2,
      leftGlowW,
      leftGlowH,
    );
    pushRect(
      (FIELD_W - PADDLE_X - PADDLE_W) * sx - (rightGlowW - PADDLE_W * sx) / 2,
      renderRight * sy - (rightGlowH - PADDLE_H * sy) / 2,
      rightGlowW,
      rightGlowH,
    );
    flushBatch(0.45, 0.35, 0.95, 0.16);
  }

  if (onField) {
    beginBatch();
    pushRect(PADDLE_X * sx, renderLeft * sy, PADDLE_W * sx, PADDLE_H * sy);
    pushRect(
      (FIELD_W - PADDLE_X - PADDLE_W) * sx,
      renderRight * sy,
      PADDLE_W * sx,
      PADDLE_H * sy,
    );
    flushBatch(0.90, 0.93, 0.98, 1);

    beginBatch();
    pushRect(PADDLE_X * sx + 1, renderLeft * sy + 1, PADDLE_W * sx - 2, PADDLE_H * sy - 2);
    flushBatch(0.48, 0.88, 1.0, 1);

    beginBatch();
    pushRect(
      (FIELD_W - PADDLE_X - PADDLE_W) * sx + 1,
      renderRight * sy + 1,
      PADDLE_W * sx - 2,
      PADDLE_H * sy - 2,
    );
    flushBatch(1.0, 0.55, 0.92, 1);
  }

  if (renderBall && running) {
    beginBatch();
    pushEllipse(renderBall.x * sx, renderBall.y * sy, BALL * sx, BALL * sy);
    flushBatch(240 / 255, 240 / 255, 240 / 255, 1);
  }

  if (onField) {
    beginBatch();
    for (let i = 0; i < leftScore; i++) {
      pushRect(20 + i * 14, 14, 10, 16);
    }
    for (let i = 0; i < rightScore; i++) {
      pushRect(width - 30 - i * 14, 14, 10, 16);
    }
    flushBatch(120 / 255, 220 / 255, 120 / 255, 1);
  }

  const startingOverlay = getStartingOverlayText();
  if (startingOverlay) {
    const overlayScale = 4;
    const overlayWidthPx = startingOverlay.length * 4 * overlayScale;
    const overlayX = Math.max(8, Math.floor(width / 2 - overlayWidthPx / 2));
    const overlayY = 24;
    const overlayPadX = 12;
    const overlayPadY = 8;
    beginBatch();
    pushRect(
      overlayX - overlayPadX,
      overlayY - overlayPadY,
      overlayWidthPx + overlayPadX * 2,
      5 * overlayScale + overlayPadY * 2,
    );
    flushBatch(0.03, 0.05, 0.1, 0.82);
    drawText(startingOverlay, overlayX + 2, overlayY + 2, overlayScale, [0.08, 0.1, 0.18, 0.95]);
    drawText(startingOverlay, overlayX, overlayY, overlayScale, [1.0, 0.96, 0.52, 1.0]);
  }

  if (local.phase !== "running" && local.phase !== "starting") {
    const layout = getLobbyLayout(playHeight);
    const panelX = layout.panelX;
    const panelY = layout.panelY;
    const buttons = getUiButtons(playHeight);
    const buttonLabels: Record<UiButton["id"], string> = {
      create: "CREATE",
      refresh: "REFRESH",
      leave: "LEAVE",
      start: "START",
      quit: "QUIT",
    };

    beginBatch();
    pushRect(panelX, panelY, UI_PANEL_W, UI_PANEL_H);
    flushBatch(14 / 255, 20 / 255, 36 / 255, 0.92);

    beginBatch();
    pushRect(panelX + 10, panelY + 10, UI_PANEL_W - 20, 8);
    if (local.phase === "error") flushBatch(0.85, 0.2, 0.2, 0.95);
    else if (local.phase === "waiting") flushBatch(0.95, 0.62, 0.2, 0.95);
    else flushBatch(0.38, 0.45, 0.82, 0.95);

    for (const button of buttons) {
      const isHover = ui.hoveredButton === button.id;
      const isPressed = ui.pressedButton === button.id;
      const lum = !button.enabled ? 0.25 : isPressed ? 0.9 : isHover ? 0.78 : 0.62;
      beginBatch();
      pushRect(button.x, button.y, button.w, button.h);
      flushBatch(0.17 * lum, 0.4 * lum, 0.8 * lum, 0.95);
      drawText(
        buttonLabels[button.id],
        button.x + 6,
        button.y + 7,
        2,
        button.enabled ? [0.9, 0.95, 1.0, 1] : [0.45, 0.55, 0.68, 1],
      );
    }

    drawText("ROOM LOBBY", panelX + 14, layout.headerY, 2, [0.9, 0.95, 1.0, 1]);
    drawText(`STATUS ${getUiStatusText().slice(0, 44)}`, panelX + 16, layout.statusY, 2, [
      0.78, 0.9, 1.0, 1,
    ]);
    drawText(`ROOM ${local.roomId ?? "-"}`, panelX + 16, layout.buttonsY + 30, 2, [0.7, 0.9, 1.0, 1]);
    drawText(`ROLE ${local.role ?? "-"}`, panelX + 190, layout.buttonsY + 30, 2, [0.7, 0.9, 1.0, 1]);
    if (ui.errorText) {
      drawText(`ERR ${ui.errorText.slice(0, 54)}`, panelX + 16, layout.footerY - 40, 2, [
        1.0, 0.55, 0.55, 1,
      ]);
    }
    const roomRows = ui.rooms.slice(0, layout.listRows);
    for (let i = 0; i < roomRows.length; i++) {
      const room = roomRows[i]!;
      const ry = layout.listY + i * (layout.listRowH + layout.listRowGap);
      beginBatch();
      pushRect(panelX + 16, ry, UI_PANEL_W - 32, layout.listRowH);
      flushBatch(0.12, 0.2, 0.36, 0.8);
      drawText(
        `${room.roomId} ${room.hostName.slice(0, 8)} ${room.connected}/2 ${room.running ? "RUN" : "WAIT"}`,
        panelX + 20,
        ry + 8,
        2,
        [0.8, 0.92, 1.0, 1],
      );
    }
    drawText("CLICK ROOM TO JOIN", panelX + 16, layout.footerY, 2, [0.72, 0.84, 0.98, 1]);
  }

  if (
    ui.resultVisible &&
    ui.resultWinner &&
    ui.resultKind &&
    local.phase !== "starting" &&
    local.phase !== "running"
  ) {
    const modalW = 360;
    const modalH = 120;
    const modalX = Math.floor(width / 2 - modalW / 2);
    const modalY = Math.floor(playHeight / 2 - modalH / 2);
    const youWon = ui.resultKind === "win";
    beginBatch();
    pushRect(modalX, modalY, modalW, modalH);
    flushBatch(0.02, 0.04, 0.1, 0.95);
    beginBatch();
    pushRect(modalX + 8, modalY + 8, modalW - 16, 10);
    flushBatch(youWon ? 0.28 : 0.85, youWon ? 0.8 : 0.2, 0.2, 0.95);
    drawText(youWon ? "VICTORY" : "DEFEAT", modalX + 120, modalY + 34, 3, [
      youWon ? 0.65 : 1.0,
      youWon ? 1.0 : 0.6,
      0.4,
      1,
    ]);
    drawText("CLICK OR WAIT", modalX + 102, modalY + 78, 2, [0.8, 0.9, 1.0, 1]);
  }

  beginBatch();
  if (local.phase === "error") {
    pushRect(0, playHeight, width, STATUS_BAR_H);
    flushBatch(130 / 255, 20 / 255, 20 / 255, 1);
  } else if (local.phase === "running") {
    pushRect(0, playHeight, width, STATUS_BAR_H);
    flushBatch(20 / 255, 120 / 255, 40 / 255, 1);
  } else if (local.phase === "finished") {
    pushRect(0, playHeight, width, STATUS_BAR_H);
    flushBatch(80 / 255, 40 / 255, 10 / 255, 1);
  } else if (local.phase === "waiting") {
    pushRect(0, playHeight, width, STATUS_BAR_H);
    flushBatch(140 / 255, 60 / 255, 20 / 255, 1);
  } else if (local.phase === "starting") {
    pushRect(0, playHeight, width, STATUS_BAR_H);
    flushBatch(160 / 255, 100 / 255, 20 / 255, 1);
  } else {
    pushRect(0, playHeight, width, STATUS_BAR_H);
    flushBatch(30 / 255, 30 / 255, 60 / 255, 1);
  }
  const statusHud = `ROOM ${local.roomId ?? "-"} PHASE ${local.phase} SIDE ${local.side ?? "-"}  ${sounds.getStatusLabel()}`;
  drawText(statusHud, 8, playHeight + 8, 2, [0.9, 0.95, 1, 1]);
  renderPostProcess(nowMs);
  gl.swap();
}

function getKeyToken(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const key = String(
    (raw as { key?: unknown; scancode?: unknown; code?: unknown }).key ??
      (raw as { scancode?: unknown }).scancode ??
      (raw as { code?: unknown }).code ??
      "",
  ).toLowerCase();
  return key;
}

function classifyMovementKey(raw: unknown): "up" | "down" | null {
  const key = getKeyToken(raw);
  if (
    key === "w" ||
    key === "keyw" ||
    key.includes("arrowup") ||
    key === "up"
  ) {
    return "up";
  }
  if (
    key === "s" ||
    key === "keys" ||
    key.includes("arrowdown") ||
    key === "down"
  ) {
    return "down";
  }
  return null;
}

function effectiveMovementInput(): PaddleInput {
  if (movementKeys.upHeld && movementKeys.downHeld) {
    return movementKeys.lastDirectionPressed === 1 ? 1 : -1;
  }
  if (movementKeys.upHeld) return -1;
  if (movementKeys.downHeld) return 1;
  return 0;
}

function applyMovementInput(): void {
  sendInput(effectiveMovementInput());
}

function sendInput(input: PaddleInput, opts?: { force?: boolean }): void {
  if (shuttingDown) return;
  if (local.phase !== "running" && local.phase !== "starting") return;
  if (!opts?.force && input === local.input) return;
  local.input = input;
  connection.sendUnreliable(
    CHANNEL_INPUT,
    encodeMessage({ type: "input", input }),
  );
}

function triggerButton(id: UiButton["id"]): void {
  if (id === "create") {
    stopCountdownInputFlush();
    local.phase = "lobby";
    ui.errorText = "";
    setPendingAction("create");
    sendCreateRoom();
    return;
  }
  if (id === "refresh") {
    stopCountdownInputFlush();
    local.phase = "lobby";
    ui.errorText = "";
    setPendingAction("refresh");
    connection.sendReliable(CHANNEL_EVENT, encodeMessage({ type: "listRooms" }), true);
    return;
  }
  if (id === "leave") {
    setPendingAction("leave");
    connection.sendReliable(CHANNEL_EVENT, encodeMessage({ type: "leaveRoom" }), true);
    return;
  }
  if (id === "start") {
    setPendingAction("start");
    connection.sendReliable(CHANNEL_EVENT, encodeMessage({ type: "startRoom" }), true);
    return;
  }
  setPendingAction("quit");
  gracefulExit(0, true);
}

window.on("mouseMove", (event: unknown) => {
  if (!event || typeof event !== "object") return;
  const e = event as { x?: number; y?: number };
  if (typeof e.x !== "number" || typeof e.y !== "number") return;
  const prevHovered = ui.hoveredButton;
  ui.mouseX = e.x;
  ui.mouseY = e.y;
  if (isLobbyPostFxActive()) {
    const playHeight = Math.max(1, height - STATUS_BAR_H);
    const nowMs = performance.now();
    const dtMs = mouseMotionRipple.hasSample
      ? Math.max(MOUSE_RIPPLE_MIN_DT_MS, nowMs - mouseMotionRipple.lastMs)
      : MOUSE_RIPPLE_MIN_DT_MS;
    const dx = mouseMotionRipple.hasSample ? ui.mouseX - mouseMotionRipple.lastX : 0;
    const dy = mouseMotionRipple.hasSample ? ui.mouseY - mouseMotionRipple.lastY : 0;
    const speed = clamp((Math.hypot(dx, dy) * 1000) / dtMs, 0, MOUSE_RIPPLE_MAX_SPEED);
    const speedNorm = speed / MOUSE_RIPPLE_MAX_SPEED;
    mouseMotionRipple.centerX = clamp(ui.mouseX, 0, width) / width;
    mouseMotionRipple.centerY = 1 - clamp(ui.mouseY, 0, playHeight) / height;
    mouseMotionRipple.strength = clamp(
      mouseMotionRipple.strength * 0.62 + speedNorm * 0.95,
      0,
      1,
    );
    mouseMotionRipple.lastX = ui.mouseX;
    mouseMotionRipple.lastY = ui.mouseY;
    mouseMotionRipple.lastMs = nowMs;
    mouseMotionRipple.hasSample = true;
  }
  if (isLobbyPostFxActive()) {
    const nowMs = performance.now();
    const dtMs = nowMs - lobbyTraceCapture.lastMs;
    const distPx = lobbyTraceCapture.hasSample
      ? Math.hypot(ui.mouseX - lobbyTraceCapture.lastX, ui.mouseY - lobbyTraceCapture.lastY)
      : LOBBY_TRACE_MIN_DIST_PX;
    if (
      !lobbyTraceCapture.hasSample ||
      dtMs >= LOBBY_TRACE_MIN_INTERVAL_MS ||
      distPx >= LOBBY_TRACE_MIN_DIST_PX
    ) {
      pushLobbyTracePoint(ui.mouseX, ui.mouseY, clamp(distPx / 26, 0.35, 1));
      lobbyTraceCapture.hasSample = true;
      lobbyTraceCapture.lastX = ui.mouseX;
      lobbyTraceCapture.lastY = ui.mouseY;
      lobbyTraceCapture.lastMs = nowMs;
    }
  }
  const playHeight = Math.max(1, height - STATUS_BAR_H);
  const buttons = getUiButtons(playHeight);
  const hit = hitButton(buttons, ui.mouseX, ui.mouseY);
  ui.hoveredButton = hit?.id ?? null;
  if (ui.hoveredButton !== prevHovered && ui.hoveredButton !== null) {
    const b = buttons.find((x) => x.id === ui.hoveredButton);
    if (b?.enabled) sounds.playHover();
  }
});

window.on("mouseButtonDown", (event: unknown) => {
  if (!event || typeof event !== "object") return;
  const e = event as { x?: number; y?: number; button?: number };
  if (e.button !== sdl.mouse.BUTTON.LEFT) return;
  if (typeof e.x !== "number" || typeof e.y !== "number") return;
  ui.mouseX = e.x;
  ui.mouseY = e.y;
  const playHeight = Math.max(1, height - STATUS_BAR_H);
  const buttons = getUiButtons(playHeight);
  ui.pressedButton = hitButton(buttons, ui.mouseX, ui.mouseY)?.id ?? null;
});

window.on("mouseButtonUp", (event: unknown) => {
  if (!event || typeof event !== "object") return;
  const e = event as { x?: number; y?: number; button?: number };
  if (e.button !== sdl.mouse.BUTTON.LEFT) return;
  if (typeof e.x !== "number" || typeof e.y !== "number") return;
  ui.mouseX = e.x;
  ui.mouseY = e.y;
  if (ui.resultVisible) {
    dismissResultModal();
    ui.pressedButton = null;
    return;
  }
  const buttons = getUiButtons(Math.max(1, height - STATUS_BAR_H));
  const releasedOn = hitButton(buttons, ui.mouseX, ui.mouseY);
  if (releasedOn && ui.pressedButton === releasedOn.id && releasedOn.enabled) {
    sounds.playClick();
    triggerButton(releasedOn.id);
  } else {
    const roomRow = getRoomRowAt(ui.mouseX, ui.mouseY, Math.max(1, height - STATUS_BAR_H));
    if (roomRow && !roomRow.running && roomRow.connected < 2 && local.phase !== "running") {
      sendJoinRoom(roomRow.roomId);
    }
  }
  ui.pressedButton = null;
});

window.on("keyDown", (event: unknown) => {
  const raw = getKeyToken(event);
  if (raw === "m") {
    sounds.toggleMute();
    return;
  }
  if (raw.includes("[") || raw.toLowerCase().includes("bracketleft")) {
    sounds.setMaster(sounds.getMaster() - 0.1);
    return;
  }
  if (raw.includes("]") || raw.toLowerCase().includes("bracketright")) {
    sounds.setMaster(sounds.getMaster() + 0.1);
    return;
  }
  if (ui.resultVisible && (raw.includes("enter") || raw.includes("space"))) {
    dismissResultModal();
    return;
  }
  if (raw === "c") {
    triggerButton("create");
    return;
  }
  if (raw === "j") {
    triggerButton("refresh");
    return;
  }
  if (raw === "l") {
    triggerButton("leave");
    return;
  }
  if (raw === "k") {
    triggerButton("start");
    return;
  }
  if (raw === "q") {
    triggerButton("quit");
  }
  const movementKey = classifyMovementKey(event);
  if (movementKey === "up") {
    movementKeys.upHeld = true;
    movementKeys.lastDirectionPressed = -1;
    applyMovementInput();
  } else if (movementKey === "down") {
    movementKeys.downHeld = true;
    movementKeys.lastDirectionPressed = 1;
    applyMovementInput();
  }
});

window.on("keyUp", (event: unknown) => {
  const movementKey = classifyMovementKey(event);
  if (movementKey === "up") {
    movementKeys.upHeld = false;
  } else if (movementKey === "down") {
    movementKeys.downHeld = false;
  } else {
    return;
  }
  applyMovementInput();
});

window.on("close", () => {
  gracefulExit(0, true);
});

connection.on("message", (event) => {
  if (event.channel !== CHANNEL_EVENT) return;
  const msg = decodeServerMessage(event.data);
  if (!msg) return;
  markServerReachable();
  dispatchStartupActionIfNeeded();
  const prev = metrics.incomingByType.get(msg.type) ?? { count: 0, bytes: 0 };
  prev.count += 1;
  prev.bytes += event.data.length;
  metrics.incomingByType.set(msg.type, prev);

  applyRoomServerMessage(msg);
  if (msg.type === "gameStart") {
    applyGameStart(msg);
    ui.statusText = `Playing room ${local.roomId ?? "-"}`;
    console.log("game started");
  } else if (msg.type === "reconnectAccepted") {
    ui.statusText = `Reconnected ${msg.roomId ? `to ${msg.roomId}` : ""}`.trim();
  } else if (msg.type === "ballEvent") {
    applyBallEvent(msg);
  } else if (msg.type === "inputEvent") {
    applyInputEvent(msg);
  } else if (msg.type === "versionMismatch") {
    console.log(
      `protocol mismatch: expected=${msg.expectedVersion}, server saw=${msg.actualVersion}`,
    );
    gracefulExit(1, false);
  }
});

startBootstrapLoop();

pendingWatchTimer = setInterval(() => {
  if (ui.pendingAction && performance.now() > ui.pendingActionUntilMs) {
    ui.statusText = `Action timeout: ${ui.pendingAction}`;
    clearPendingAction();
  }
}, 100);

heartbeatTimer = setInterval(() => {
  if (shuttingDown) return;
  connection.sendReliable(CHANNEL_EVENT, encodeMessage({ type: "heartbeat", nowMs: Date.now() }), true);
}, 3000);

simulationTimer = setInterval(() => {
  const now = performance.now();
  const dtMs = Math.min(250, now - lastSimulationPerf);
  lastSimulationPerf = now;
  simulationAccumulatorMs += dtMs;
  while (simulationAccumulatorMs >= SIM_STEP_MS) {
    const stepSec = SIM_STEP_MS / 1000;
    updateVisualFx(stepSec);
    if (running || local.phase === "starting") {
      leftY += getLeftInput() * PADDLE_SPEED * stepSec;
      rightY += getRightInput() * PADDLE_SPEED * stepSec;
      leftY = clamp(leftY, 0, FIELD_H - PADDLE_H);
      rightY = clamp(rightY, 0, FIELD_H - PADDLE_H);
    }
    if (running && ball) {
      integrateBallOneStep(ball, stepSec);
    }
    simulationAccumulatorMs -= SIM_STEP_MS;
  }
}, 1);

let lastRenderPerf = performance.now();
renderTimer = setInterval(() => {
  const now = performance.now();
  metrics.renderDtMs.push(now - lastRenderPerf);
  lastRenderPerf = now;
  draw();
}, 16);

metricsLogTimer = setInterval(() => {
  const sorted = [...metrics.correctionPx].sort((a, b) => a - b);
  const p95 =
    sorted.length > 0
      ? sorted[Math.floor((sorted.length - 1) * 0.95)]?.toFixed(2)
      : "0.00";
  const max = sorted.length > 0 ? sorted[sorted.length - 1]?.toFixed(2) : "0.00";
  const render = [...metrics.renderDtMs];
  const renderMeanValue =
    render.length > 0 ? render.reduce((a, b) => a + b, 0) / render.length : 0;
  const renderMean = renderMeanValue.toFixed(2);
  const renderVar =
    render.length > 0
      ? Math.sqrt(
          render.reduce((a, b) => a + (b - renderMeanValue) ** 2, 0) / render.length,
        ).toFixed(2)
      : "0.00";
  const inbound = [...metrics.incomingByType.entries()]
    .map(([t, v]) => `${t}=count:${v.count},bytes:${v.bytes}`)
    .join(" ");
  console.log(
    `[metrics] corrections(count/snaps/p95/max/snapshots)=${metrics.correctionCount}/${metrics.correctionSnapCount}/${p95}/${max}/${authoritativeBallSnapshots.length} render(ms mean/std)=${renderMean}/${renderVar} ${inbound}`,
  );
  metrics.correctionPx.length = 0;
  metrics.renderDtMs.length = 0;
  metrics.correctionCount = 0;
  metrics.correctionSnapCount = 0;
  metrics.incomingByType.clear();
}, 2000);

console.log(`client started -> ${host}:${port} as ${name}`);
