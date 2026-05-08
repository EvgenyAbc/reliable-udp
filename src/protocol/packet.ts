import { Buffer } from "node:buffer";
import { FLAGS, HEADER_SIZE, SACK_BYTES_DEFAULT } from "./types.js";

export interface PacketInput {
  flags: number;
  channel: number;
  seq: number;
  ack: number;
  timestamp: number;
  fragTotal: number;
  fragId: number;
  payload: Buffer;
  fragmentMessageId: number;
  sackBitmap?: Buffer;
}

/**
 * Binary header: 16 bytes little-endian + optional SACK + payload.
 * When {@link FLAGS.HAS_SACK} is set, {@link SACK_BYTES_DEFAULT} bytes follow the header.
 */
export class Packet implements PacketInput {
  flags = 0;
  channel = 0;
  seq = 0;
  ack = 0;
  timestamp = 0;
  fragTotal = 0;
  fragId = 0;
  payload: Buffer;
  fragmentMessageId = 0;
  reserved = 0;
  sackBitmap?: Buffer;

  constructor(payload: Buffer = Buffer.alloc(0)) {
    this.payload = payload;
  }

  serialize(sackBytes: number = SACK_BYTES_DEFAULT): Buffer {
    const hasSack = (this.flags & FLAGS.HAS_SACK) !== 0;
    const sackLen = hasSack ? sackBytes : 0;
    const out = Buffer.allocUnsafe(HEADER_SIZE + sackLen + this.payload.length);
    out.writeUInt8(this.flags & 0xff, 0);
    out.writeUInt8(this.channel & 0xff, 1);
    out.writeUInt16LE(this.seq & 0xffff, 2);
    out.writeUInt16LE(this.ack & 0xffff, 4);
    out.writeUInt16LE(this.timestamp & 0xffff, 6);
    out.writeUInt8(this.fragTotal & 0xff, 8);
    out.writeUInt8(this.fragId & 0xff, 9);
    out.writeUInt16LE(this.payload.length & 0xffff, 10);
    out.writeUInt16LE(this.fragmentMessageId & 0xffff, 12);
    out.writeUInt16LE(this.reserved & 0xffff, 14);
    let o = HEADER_SIZE;
    if (hasSack) {
      const sb = this.sackBitmap ?? Buffer.alloc(sackBytes, 0);
      const region = Buffer.alloc(sackBytes, 0);
      sb.copy(region, 0, 0, Math.min(sb.length, sackBytes));
      region.copy(out, o);
      o += sackBytes;
    }
    this.payload.copy(out, o);
    return out;
  }

  static deserialize(buffer: Buffer, sackBytes: number = SACK_BYTES_DEFAULT): Packet {
    if (buffer.length < HEADER_SIZE) {
      throw new Error(`Packet too short: ${buffer.length}`);
    }
    const flags = buffer.readUInt8(0);
    const p = new Packet();
    p.flags = flags;
    p.channel = buffer.readUInt8(1);
    p.seq = buffer.readUInt16LE(2);
    p.ack = buffer.readUInt16LE(4);
    p.timestamp = buffer.readUInt16LE(6);
    p.fragTotal = buffer.readUInt8(8);
    p.fragId = buffer.readUInt8(9);
    const payloadLen = buffer.readUInt16LE(10);
    p.fragmentMessageId = buffer.readUInt16LE(12);
    p.reserved = buffer.readUInt16LE(14);
    let offset = HEADER_SIZE;
    if (flags & FLAGS.HAS_SACK) {
      if (buffer.length < offset + sackBytes) {
        throw new Error("Packet truncated before SACK");
      }
      p.sackBitmap = Buffer.from(buffer.subarray(offset, offset + sackBytes));
      offset += sackBytes;
    }
    if (buffer.length < offset + payloadLen) {
      throw new Error("Packet truncated before payload");
    }
    p.payload = Buffer.from(buffer.subarray(offset, offset + payloadLen));
    return p;
  }
}
