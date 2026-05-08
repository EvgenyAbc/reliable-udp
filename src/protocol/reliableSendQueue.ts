import { FLAGS } from "./types.js";
import type { Packet } from "./packet.js";
import type { ProtocolConfig } from "./types.js";
import type { CongestionControl } from "./congestionControl.js";
import { ReliableReceiveQueue } from "./reliableReceiveQueue.js";

export interface PendingPacket {
  packet: Packet;
  sendTimeMs: number;
  retransmitCount: number;
  onAcked?: () => void;
}

export type TransportSend = (data: Buffer) => void;

/**
 * Reliable send path: window, RTO, fast retransmit on NACK (project.md §4.3).
 */
export class ReliableSendQueue {
  private readonly pending = new Map<number, PendingPacket>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly config: ProtocolConfig,
    private readonly congestion: CongestionControl,
    private readonly transport: TransportSend,
    private readonly serialize: (p: Packet) => Buffer,
  ) {}

  getPendingSize(): number {
    return this.pending.size;
  }

  /**
   * Enqueue a reliable packet (flags must include RELIABLE). `packet.seq` must be set.
   */
  send(packet: Packet, onAcked?: () => void): boolean {
    if ((packet.flags & FLAGS.RELIABLE) === 0) {
      throw new Error("ReliableSendQueue.send expects RELIABLE packet");
    }
    if (!this.congestion.canSend(this.pending.size)) {
      return false;
    }
    const seq = packet.seq & 0xffff;
    packet.flags |= FLAGS.RELIABLE;
    this.pending.set(seq, {
      packet,
      sendTimeMs: Date.now(),
      retransmitCount: 0,
      onAcked,
    });
    this.transport(this.serialize(packet));
    this.startRetransmitTimer(seq);
    return true;
  }

  onAck(peerAckNextExpected: number, sack?: Buffer): void {
    const toDelete: number[] = [];
    for (const seq of this.pending.keys()) {
      if (ReliableReceiveQueue.isSeqAcked(seq, peerAckNextExpected, sack)) {
        toDelete.push(seq);
      }
    }
    toDelete.sort((a, b) => a - b);
    for (const seq of toDelete) {
      const pend = this.pending.get(seq);
      if (!pend) continue;
      this.congestion.onPacketAcked(seq, pend.sendTimeMs, true);
      pend.onAcked?.();
      this.clearTimer(seq);
      this.pending.delete(seq);
    }
  }

  onNack(missingSeq: number): void {
    const seq = missingSeq & 0xffff;
    const pend = this.pending.get(seq);
    if (!pend) return;
    this.congestion.onPacketLost(seq);
    this.retransmit(seq);
  }

  private retransmit(seq: number): void {
    const pend = this.pending.get(seq);
    if (!pend) return;
    pend.retransmitCount += 1;
    pend.sendTimeMs = Date.now();
    this.transport(this.serialize(pend.packet));
    this.clearTimer(seq);
    this.startRetransmitTimer(seq);
  }

  private startRetransmitTimer(seq: number): void {
    const rto = Math.max(10, this.congestion.getRtoMs() * this.config.retransmitTimeoutMultiplier);
    const t = setTimeout(() => {
      this.timers.delete(seq);
      const pend = this.pending.get(seq);
      if (!pend) return;
      if (pend.retransmitCount >= this.config.maxRetransmits) {
        this.pending.delete(seq);
        return;
      }
      this.congestion.onTimeout();
      this.retransmit(seq);
    }, rto);
    this.timers.set(seq, t);
  }

  private clearTimer(seq: number): void {
    const t = this.timers.get(seq);
    if (t) clearTimeout(t);
    this.timers.delete(seq);
  }

  clear(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.pending.clear();
  }
}
