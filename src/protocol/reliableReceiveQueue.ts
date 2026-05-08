import type { Packet } from "./packet.js";
import type { ProtocolConfig } from "./types.js";

function sackBitSet(sack: Buffer | undefined, bitIndex: number): boolean {
  if (!sack || bitIndex < 0) return false;
  const byte = bitIndex >> 3;
  if (byte >= sack.length) return false;
  return ((sack[byte]! >> (bitIndex & 7)) & 1) !== 0;
}

/**
 * Global sequence reorder buffer + cumulative / SACK generation (project.md §4.4).
 * `ack` on the wire = next sequence number we expect from the peer (all seq &lt; ack received).
 */
export class ReliableReceiveQueue {
  private readonly received = new Map<number, Packet>();
  private expectedSeq = 0;
  private sackBits: number;

  constructor(
    private readonly config: ProtocolConfig,
    private readonly onDeliver: (packet: Packet) => void,
    private readonly onGap?: (missingSeq: number) => void,
  ) {
    this.sackBits = config.sackBitmapBits;
  }

  getExpectedSeq(): number {
    return this.expectedSeq;
  }

  reset(expectedSeq = 0): void {
    this.expectedSeq = expectedSeq;
    this.received.clear();
  }

  push(packet: Packet): void {
    const seq = packet.seq & 0xffff;
    const exp = this.expectedSeq & 0xffff;
    if (seq !== exp) {
      const d = (exp - seq) & 0xffff;
      if (d !== 0 && d < 0x8000) {
        return;
      }
    }
    if (seq === exp) {
      this.onDeliver(packet);
      this.expectedSeq = (this.expectedSeq + 1) & 0xffff;
      this.tryDeliver();
      return;
    }
    if (!this.received.has(seq)) {
      this.received.set(seq, packet);
      if (this.onGap && this.gapFromExpected(seq)) {
        this.onGap(this.expectedSeq);
      }
    }
    this.tryDeliver();
  }

  private gapFromExpected(seq: number): boolean {
    const d = (seq - this.expectedSeq) & 0xffff;
    return d > 0 && d < 0x8000;
  }

  private tryDeliver(): void {
    for (;;) {
      const p = this.received.get(this.expectedSeq);
      if (!p) break;
      this.received.delete(this.expectedSeq);
      this.onDeliver(p);
      this.expectedSeq = (this.expectedSeq + 1) & 0xffff;
    }
  }

  /**
   * Build ack (next expected seq) and SACK bitmap relative to that ack.
   */
  generateAck(): { ack: number; sack: Buffer } {
    const ack = this.expectedSeq & 0xffff;
    const byteLen = Math.ceil(this.sackBits / 8);
    const sack = Buffer.alloc(byteLen, 0);
    for (const seq of this.received.keys()) {
      const d = (seq - ack) & 0xffff;
      if (d === 0 || d >= 0x8000) continue;
      const bit = (d - 1) & 0xffff;
      if (bit >= this.sackBits) continue;
      sack[bit >> 3]! |= 1 << (bit & 7);
    }
    return { ack, sack };
  }

  /**
   * Whether a sender-side pending seq is acked by peer ack + optional SACK.
   * `peerAckNextExpected` is the next sequence number the peer expects (cumulative).
   */
  static isSeqAcked(
    pendingSeq: number,
    peerAckNextExpected: number,
    sack?: Buffer,
  ): boolean {
    const ps = pendingSeq & 0xffff;
    const ack = peerAckNextExpected & 0xffff;
    const d = (ack - ps) & 0xffff;
    if (d !== 0 && d < 0x8000) {
      return true;
    }
    if (!sack) return false;
    const bit = (ps - ack - 1) & 0xffff;
    return sackBitSet(sack, bit);
  }
}
