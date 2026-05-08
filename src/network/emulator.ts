import { Buffer } from "node:buffer";

export interface NetworkEmulatorOptions {
  rng?: () => number;
  schedule?: (delayMs: number, run: () => void) => void;
}

/**
 * Loss / delay / duplication helper for tests (project.md §7).
 */
export class NetworkEmulator {
  latencyMs = 50;
  jitterMs = 20;
  lossRate = 0.05;
  duplicateRate = 0.01;
  private readonly rng: () => number;
  private readonly schedule: (delayMs: number, run: () => void) => void;

  constructor(options: NetworkEmulatorOptions = {}) {
    this.rng = options.rng ?? Math.random;
    this.schedule = options.schedule ?? ((delayMs, run) => setTimeout(run, delayMs));
  }

  send(raw: Buffer, target: (buf: Buffer) => void): void {
    if (this.rng() < this.lossRate) {
      return;
    }
    const delay =
      this.latencyMs + (this.jitterMs > 0 ? this.rng() * this.jitterMs : 0);
    const copy = Buffer.from(raw);
    this.schedule(delay, () => {
      target(copy);
      if (this.rng() < this.duplicateRate) {
        target(Buffer.from(raw));
      }
    });
  }
}
