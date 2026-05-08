import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { Packet } from "./packet.js";
import { CongestionControl } from "./congestionControl.js";
import { FragmentReassembler } from "./fragmentReassembler.js";
import { ReliableReceiveQueue } from "./reliableReceiveQueue.js";
import { ReliableSendQueue, type TransportSend } from "./reliableSendQueue.js";
import {
  FLAGS,
  HEADER_SIZE,
  SACK_BYTES_DEFAULT,
  type ProtocolConfig,
  defaultProtocolConfig,
} from "./types.js";

export interface MessageEvent {
  channel: number;
  data: Buffer;
  reliable: boolean;
  ordered: boolean;
}

function mergeConfig(partial?: Partial<ProtocolConfig>): ProtocolConfig {
  return { ...defaultProtocolConfig, ...partial };
}

function sackHasBits(sack: Buffer): boolean {
  for (let i = 0; i < sack.length; i++) {
    if (sack[i] !== 0) return true;
  }
  return false;
}

/**
 * Multiplexed reliable / unreliable transport over datagrams (project.md §4.7).
 */
export class ReliableUdpConnection extends EventEmitter {
  private readonly config: ProtocolConfig;
  private readonly congestion: CongestionControl;
  private readonly receiveQueue: ReliableReceiveQueue;
  private readonly sendQueue: ReliableSendQueue;
  private readonly frags: FragmentReassembler;
  private readonly transport: TransportSend;
  private readonly sackBytes: number;

  private nextSendSeq = 0;
  private nextFragmentMessageId = 1;

  constructor(
    config: Partial<ProtocolConfig> | undefined,
    transport: TransportSend,
  ) {
    super();
    this.config = mergeConfig(config);
    this.transport = transport;
    this.sackBytes = Math.ceil(this.config.sackBitmapBits / 8);
    this.congestion = new CongestionControl(this.config);
    this.frags = new FragmentReassembler(this.config);
    this.receiveQueue = new ReliableReceiveQueue(
      this.config,
      (p) => this.deliverFromPeer(p),
      (missing) => this.scheduleNack(missing),
    );
    this.sendQueue = new ReliableSendQueue(
      this.config,
      this.congestion,
      this.transport,
      (p) => this.serializeWire(p),
    );
  }

  /** Process an inbound datagram (UDP message, RTC binary, etc.). */
  receive(raw: Buffer): void {
    let packet: Packet;
    try {
      packet = Packet.deserialize(raw, this.sackBytes);
    } catch {
      return;
    }
    this.sendQueue.onAck(packet.ack, packet.sackBitmap);
    if ((packet.flags & FLAGS.NACK) !== 0 && packet.payload.length >= 2) {
      const miss = packet.payload.readUInt16LE(0);
      this.sendQueue.onNack(miss);
    }
    this.receiveQueue.push(packet);
    // Always emit ack-only on inbound payloads. Delayed ACK scheduling is not
    // implemented yet, so relying on ackDelayMs>0 can stall reliable streams
    // when the receiver has no outgoing traffic to piggyback ACKs on.
    if (packet.payload.length > 0) {
      this.sendAckOnly();
    }
  }

  /**
   * Send a reliable message. Returns false if the congestion window is full (caller should retry).
   */
  sendReliable(
    channel: number,
    data: Buffer,
    ordered = true,
    onAcked?: () => void,
  ): boolean {
    const p = new Packet(data);
    p.channel = channel & 0xff;
    p.flags = FLAGS.RELIABLE | (ordered ? FLAGS.ORDERED : 0);
    const maxData = this.maxUserPayloadPerPacket();
    if (data.length > maxData) {
      return this.fragmentAndSendReliable(p, onAcked);
    }
    p.seq = this.bumpSeq();
    return this.sendQueue.send(p, onAcked);
  }

  sendUnreliable(channel: number, data: Buffer): void {
    const p = new Packet(data);
    p.channel = channel & 0xff;
    p.flags &= ~FLAGS.RELIABLE;
    const maxData = this.maxUserPayloadPerPacket();
    if (data.length > maxData) {
      this.fragmentAndSendUnreliable(p);
      return;
    }
    p.seq = this.bumpSeq();
    this.transport(this.serializeWire(p));
  }

  getCongestion(): CongestionControl {
    return this.congestion;
  }

  getReceiveQueue(): ReliableReceiveQueue {
    return this.receiveQueue;
  }

  clear(): void {
    this.sendQueue.clear();
    this.frags.clear();
    this.receiveQueue.reset(0);
  }

  private bumpSeq(): number {
    const s = this.nextSendSeq & 0xffff;
    this.nextSendSeq = (this.nextSendSeq + 1) & 0xffff;
    return s;
  }

  private maxUserPayloadPerPacket(): number {
    return Math.max(0, this.config.maxPacketSize - HEADER_SIZE - SACK_BYTES_DEFAULT);
  }

  private maxFragmentPayload(): number {
    return Math.max(
      0,
      this.config.maxPacketSize - HEADER_SIZE - SACK_BYTES_DEFAULT,
    );
  }

  private prepareOutgoingPacket(p: Packet): void {
    const { ack, sack } = this.receiveQueue.generateAck();
    p.ack = ack;
    if (sackHasBits(sack)) {
      p.flags |= FLAGS.HAS_SACK;
      p.sackBitmap = sack;
    } else {
      p.flags &= ~FLAGS.HAS_SACK;
      p.sackBitmap = undefined;
    }
    p.timestamp = Date.now() & 0xffff;
  }

  private serializeWire(p: Packet): Buffer {
    this.prepareOutgoingPacket(p);
    return p.serialize(this.sackBytes);
  }

  private fragmentAndSendReliable(p: Packet, onAcked?: () => void): boolean {
    const chunk = this.maxFragmentPayload();
    if (chunk <= 0) return false;
    const messageId = this.nextFragmentMessageId & 0xffff;
    this.nextFragmentMessageId = (this.nextFragmentMessageId + 1) & 0xffff;
    const total = Math.ceil(p.payload.length / chunk);
    if (total > this.config.maxFragments) return false;
    let ok = true;
    let first = true;
    for (let i = 0; i < total; i++) {
      const slice = p.payload.subarray(i * chunk, (i + 1) * chunk);
      const fp = new Packet(Buffer.from(slice));
      fp.channel = p.channel;
      fp.flags = p.flags | FLAGS.FRAGMENTED;
      fp.seq = this.bumpSeq();
      fp.fragTotal = total;
      fp.fragId = i;
      fp.fragmentMessageId = messageId;
      const ack = first ? onAcked : undefined;
      first = false;
      if (!this.sendQueue.send(fp, ack)) {
        ok = false;
      }
    }
    return ok;
  }

  private fragmentAndSendUnreliable(p: Packet): void {
    const chunk = this.maxFragmentPayload();
    if (chunk <= 0) return;
    const messageId = this.nextFragmentMessageId & 0xffff;
    this.nextFragmentMessageId = (this.nextFragmentMessageId + 1) & 0xffff;
    const total = Math.ceil(p.payload.length / chunk);
    if (total > this.config.maxFragments) return;
    for (let i = 0; i < total; i++) {
      const slice = p.payload.subarray(i * chunk, (i + 1) * chunk);
      const fp = new Packet(Buffer.from(slice));
      fp.channel = p.channel;
      fp.flags = (p.flags & ~FLAGS.RELIABLE) | FLAGS.FRAGMENTED;
      fp.seq = this.bumpSeq();
      fp.fragTotal = total;
      fp.fragId = i;
      fp.fragmentMessageId = messageId;
      this.transport(this.serializeWire(fp));
    }
  }

  private deliverFromPeer(p: Packet): void {
    if (p.payload.length === 0 && (p.flags & FLAGS.NACK) === 0) {
      return;
    }
    if ((p.flags & FLAGS.NACK) !== 0 && (p.flags & FLAGS.RELIABLE) === 0) {
      return;
    }
    if ((p.flags & FLAGS.FRAGMENTED) !== 0) {
      const assembled = this.frags.addFragment(
        p.fragmentMessageId,
        p.fragId,
        p.fragTotal,
        p.payload,
        { channel: p.channel, flags: p.flags },
      );
      if (assembled) {
        this.emitMessage(assembled.buffer, assembled.channel, assembled.flags);
      }
      return;
    }
    this.emitMessage(p.payload, p.channel, p.flags);
  }

  private emitMessage(data: Buffer, channel: number, flags: number): void {
    const reliable = (flags & FLAGS.RELIABLE) !== 0;
    const ordered = (flags & FLAGS.ORDERED) !== 0;
    const ev: MessageEvent = {
      channel,
      data,
      reliable,
      ordered,
    };
    this.emit("message", ev);
  }

  /** Standalone ack (piggyback fields only) so peers can advance their send window without user traffic. */
  private sendAckOnly(): void {
    const p = new Packet(Buffer.alloc(0));
    p.seq = this.bumpSeq();
    this.transport(this.serializeWire(p));
  }

  private scheduleNack(missingSeq: number): void {
    const pay = Buffer.allocUnsafe(2);
    pay.writeUInt16LE(missingSeq & 0xffff, 0);
    const p = new Packet(pay);
    p.flags = FLAGS.NACK;
    p.channel = 0;
    p.seq = this.bumpSeq();
    this.transport(this.serializeWire(p));
  }
}
