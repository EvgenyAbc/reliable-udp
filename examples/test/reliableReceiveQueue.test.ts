import { describe, expect, it } from "vitest";
import { Packet, ReliableReceiveQueue, defaultProtocolConfig } from "reliable-udp";

function packet(seq: number): Packet {
  const p = new Packet(Buffer.from([seq & 0xff]));
  p.seq = seq & 0xffff;
  return p;
}

describe("ReliableReceiveQueue", () => {
  it("handles sequence wraparound and in-order delivery", () => {
    const delivered: number[] = [];
    const q = new ReliableReceiveQueue(defaultProtocolConfig, (p) => delivered.push(p.seq));
    q.reset(0xfffe);

    q.push(packet(0xffff));
    q.push(packet(0xfffe));
    q.push(packet(0));

    expect(delivered).toEqual([0xfffe, 0xffff, 0]);
    expect(q.getExpectedSeq()).toBe(1);
  });

  it("builds sack bits for out-of-order packets", () => {
    const q = new ReliableReceiveQueue(defaultProtocolConfig, () => {});
    q.reset(10);
    q.push(packet(12));
    q.push(packet(15));

    const { ack, sack } = q.generateAck();
    expect(ack).toBe(10);
    expect((sack[0]! & (1 << 1)) !== 0).toBe(true);
    expect((sack[0]! & (1 << 4)) !== 0).toBe(true);
  });
});
