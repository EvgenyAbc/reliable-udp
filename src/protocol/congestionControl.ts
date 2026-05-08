import type { ProtocolConfig } from "./types.js";

/**
 * NewReno-style congestion window and RTT (project.md §4.5).
 */
export class CongestionControl {
  private cwnd: number;
  private ssthresh: number;
  private rttMs: number;
  private rttvarMs: number;
  private rtoMs: number;

  constructor(private readonly config: ProtocolConfig) {
    this.cwnd = config.initialCwnd;
    this.ssthresh = 64;
    this.rttMs = config.initialRttMs;
    this.rttvarMs = 0;
    this.rtoMs = Math.max(200, 2 * config.initialRttMs);
  }

  getCwnd(): number {
    return this.cwnd;
  }

  getRtoMs(): number {
    return this.rtoMs;
  }

  getRttMs(): number {
    return this.rttMs;
  }

  onPacketAcked(_seq: number, sendTimeMs: number, isNewAck: boolean): void {
    const now = Date.now();
    const measured = Math.max(1, now - sendTimeMs);
    const beta = 0.125;
    const beta2 = 0.25;
    this.rttvarMs = (1 - beta2) * this.rttvarMs + beta2 * Math.abs(this.rttMs - measured);
    this.rttMs = (1 - beta) * this.rttMs + beta * measured;
    this.rtoMs = Math.min(
      60_000,
      Math.max(50, this.rttMs + 4 * this.rttvarMs),
    );

    if (!isNewAck) return;

    if (this.cwnd < this.ssthresh) {
      this.cwnd += 1;
    } else {
      this.cwnd += 1 / this.cwnd;
    }
  }

  onPacketLost(_seq: number): void {
    this.ssthresh = Math.max(2, Math.floor(this.cwnd / 2));
    this.cwnd = this.ssthresh + 3;
  }

  onTimeout(): void {
    this.ssthresh = Math.max(2, Math.floor(this.cwnd / 2));
    this.cwnd = 1;
  }

  canSend(pendingCount: number): boolean {
    return pendingCount < this.cwnd;
  }
}
