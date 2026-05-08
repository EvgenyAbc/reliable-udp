import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { FLAGS, Packet, SACK_BYTES_DEFAULT } from "reliable-udp";

describe("Packet", () => {
  it("roundtrips header and payload without SACK", () => {
    const p = new Packet(Buffer.from("hello"));
    p.flags = FLAGS.RELIABLE | FLAGS.ORDERED;
    p.channel = 3;
    p.seq = 42;
    p.ack = 7;
    p.timestamp = 1234;
    p.fragTotal = 0;
    p.fragId = 0;
    p.fragmentMessageId = 0;
    const wire = p.serialize(SACK_BYTES_DEFAULT);
    const q = Packet.deserialize(wire, SACK_BYTES_DEFAULT);
    expect(q.payload.toString()).toBe("hello");
    expect(q.flags & FLAGS.RELIABLE).toBe(FLAGS.RELIABLE);
    expect(q.channel).toBe(3);
    expect(q.seq).toBe(42);
    expect(q.ack).toBe(7);
  });

  it("roundtrips with HAS_SACK", () => {
    const p = new Packet(Buffer.from("x"));
    p.flags = FLAGS.HAS_SACK;
    p.sackBitmap = Buffer.alloc(SACK_BYTES_DEFAULT, 0);
    p.sackBitmap[0] = 0b101;
    const wire = p.serialize(SACK_BYTES_DEFAULT);
    const q = Packet.deserialize(wire, SACK_BYTES_DEFAULT);
    expect(q.sackBitmap?.[0]).toBe(0b101);
    expect(q.payload.toString()).toBe("x");
  });
});
