import { Buffer } from "node:buffer";
import type { BallEventReason } from "./protocol.js";

const SAMPLE_RATE = 48_000;
const UI_GAIN = 0.42;
const SFX_GAIN = 1;
/** Extra headroom so bursts stay away from clip. */
const OUTPUT_HEADROOM = 0.22;

type SdlAudioDevice = { type: "playback" | "recording"; name?: string };

type AudioPlaybackApi = {
  readonly playing: boolean;
  enqueue(buffer: Buffer, bytes?: number): void;
  play(play?: boolean): void;
  close(): void;
};

type SdlWithAudio = {
  audio: {
    readonly devices: SdlAudioDevice[];
    openDevice(device: SdlAudioDevice & { type: "playback" }, options?: object): AudioPlaybackApi;
  };
};

function floatsToBuffer(samples: Float32Array): Buffer {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

/** Short sine burst with exponential decay. */
function toneBurst(
  freqHz: number,
  durationMs: number,
  peak: number,
  decayPerSec: number,
): Float32Array {
  const n = Math.max(1, Math.floor((SAMPLE_RATE * durationMs) / 1000));
  const out = new Float32Array(n);
  const w = (2 * Math.PI * freqHz) / SAMPLE_RATE;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * decayPerSec);
    out[i] = peak * env * Math.sin(w * i);
  }
  return out;
}

/** Low band-limited noise burst (smoothed white noise). */
function noiseThunk(durationMs: number, peak: number): Float32Array {
  const n = Math.max(1, Math.floor((SAMPLE_RATE * durationMs) / 1000));
  const out = new Float32Array(n);
  let state = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * 38);
    const white = Math.random() * 2 - 1;
    state += 0.12 * (white - state);
    out[i] = peak * env * state;
  }
  return out;
}

function twoToneGo(): Float32Array {
  const a = toneBurst(440, 55, 0.55, 14);
  const b = toneBurst(660, 90, 0.5, 11);
  const gap = Math.floor(SAMPLE_RATE * 0.028);
  const out = new Float32Array(a.length + gap + b.length);
  out.set(a, 0);
  out.set(b, a.length + gap);
  return out;
}

/** Paddle impact: short noise click + pitch-dropping body (reads like a rubber bounce). */
function paddleBounce(): Float32Array {
  const durationMs = 78;
  const n = Math.max(1, Math.floor((SAMPLE_RATE * durationMs) / 1000));
  const body = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const attack = 1 - Math.exp(-t * 220);
    const env = attack * Math.exp(-t * 10.5);
    const f = 440 * Math.exp(-t * 16) + 88;
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
    const fund = Math.sin(phase);
    const twang = 0.32 * Math.sin(phase * 2);
    body[i] = 0.94 * env * (fund + twang);
  }

  const nip = noiseThunk(14, 0.38);
  const len = Math.max(body.length, nip.length);
  const out = new Float32Array(len);
  for (let i = 0; i < nip.length; i++) out[i] = nip[i]!;
  for (let i = 0; i < body.length; i++) out[i] += body[i]!;
  return out;
}

export interface PingPongSoundPlayer {
  playBall(reason: BallEventReason): void;
  playHover(): void;
  playClick(): void;
  playCountdownTick(): void;
  playGameGo(): void;
  setMaster(volume: number): void;
  getMaster(): number;
  toggleMute(): void;
  getMuted(): boolean;
  getStatusLabel(): string;
  close(): void;
}

export function createPingPongSounds(sdl: SdlWithAudio): PingPongSoundPlayer {
  let playback: AudioPlaybackApi | null = null;
  try {
    const device = sdl.audio.devices.find((d) => d.type === "playback") as
      | (SdlAudioDevice & { type: "playback" })
      | undefined;
    if (device) {
      playback = sdl.audio.openDevice(device, {
        frequency: SAMPLE_RATE,
        format: "f32",
        channels: 1,
        buffered: 4096,
      });
      playback.play(true);
    }
  } catch {
    playback = null;
  }

  let master = 1;
  let muted = false;
  let closed = false;

  const effectiveGain = (category: "ui" | "sfx"): number => {
    if (closed || !playback || muted || master <= 0) return 0;
    const cat = category === "ui" ? UI_GAIN : SFX_GAIN;
    return OUTPUT_HEADROOM * master * cat;
  };

  const enqueueScaled = (samples: Float32Array, category: "ui" | "sfx"): void => {
    const g = effectiveGain(category);
    if (g <= 0) return;
    const scaled = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) scaled[i] = samples[i]! * g;
    playback!.enqueue(floatsToBuffer(scaled));
    if (!playback!.playing) playback!.play(true);
  };

  const presets = {
    wall: (): Float32Array => toneBurst(920, 38, 0.9, 28),
    paddle: (): Float32Array => paddleBounce(),
    reset: (): Float32Array => {
      const n = noiseThunk(55, 0.35);
      const low = toneBurst(120, 70, 0.35, 22);
      const m = Math.min(n.length, low.length);
      for (let i = 0; i < m; i++) n[i] = n[i]! + low[i]!;
      return n;
    },
    hover: (): Float32Array => toneBurst(880, 18, 0.45, 42),
    click: (): Float32Array => toneBurst(620, 24, 0.55, 36),
    countdown: (): Float32Array => toneBurst(520, 42, 0.85, 20),
    go: (): Float32Array => twoToneGo(),
  };

  return {
    playBall(reason: BallEventReason): void {
      if (!playback) return;
      if (reason === "wallBounce") enqueueScaled(presets.wall(), "sfx");
      else if (reason === "paddleHit") enqueueScaled(presets.paddle(), "sfx");
      else enqueueScaled(presets.reset(), "sfx");
    },
    playHover(): void {
      if (!playback) return;
      enqueueScaled(presets.hover(), "ui");
    },
    playClick(): void {
      if (!playback) return;
      enqueueScaled(presets.click(), "ui");
    },
    playCountdownTick(): void {
      if (!playback) return;
      enqueueScaled(presets.countdown(), "sfx");
    },
    playGameGo(): void {
      if (!playback) return;
      enqueueScaled(presets.go(), "sfx");
    },
    setMaster(volume: number): void {
      master = Math.min(1, Math.max(0, volume));
    },
    getMaster(): number {
      return master;
    },
    toggleMute(): void {
      muted = !muted;
    },
    getMuted(): boolean {
      return muted;
    },
    getStatusLabel(): string {
      if (muted) return "SND MUTE";
      return `SND ${Math.round(master * 100)}%`;
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (playback) {
        try {
          playback.close();
        } catch {
          // ignore shutdown races
        }
        playback = null;
      }
    },
  };
}
