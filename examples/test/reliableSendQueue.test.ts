import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CongestionControl,
  FLAGS,
  Packet,
  ReliableSendQueue,
  defaultProtocolConfig,
} from "reliable-udp";

describe("ReliableSendQueue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("acknowledges pending packets through SACK", () => {
    const cfg = { ...defaultProtocolConfig, sackBitmapBits: 32 };
    const congestion = new CongestionControl(cfg);
    const sent: Buffer[] = [];
    const queue = new ReliableSendQueue(
      cfg,
      congestion,
      (buf) => sent.push(Buffer.from(buf)),
      (p) => p.serialize(),
    );
    const p = new Packet(Buffer.from("x"));
    p.flags = FLAGS.RELIABLE;
    p.seq = 20;

    expect(queue.send(p)).toBe(true);
    const sack = Buffer.alloc(4, 0);
    sack[0] = 1 << 2;
    queue.onAck(17, sack);
    expect(queue.getPendingSize()).toBe(0);
    expect(sent.length).toBe(1);
  });

  it("drops packet after max retransmits", () => {
    vi.useFakeTimers();
    const cfg = {
      ...defaultProtocolConfig,
      retransmitTimeoutMultiplier: 1,
      maxRetransmits: 1,
      initialRttMs: 1,
    };
    const congestion = new CongestionControl(cfg);
    const sent: Buffer[] = [];
    const queue = new ReliableSendQueue(
      cfg,
      congestion,
      (buf) => sent.push(Buffer.from(buf)),
      (p) => p.serialize(),
    );
    const p = new Packet(Buffer.from("x"));
    p.flags = FLAGS.RELIABLE;
    p.seq = 3;

    expect(queue.send(p)).toBe(true);
    vi.advanceTimersByTime(500);
    expect(queue.getPendingSize()).toBe(0);
    expect(sent.length).toBeGreaterThanOrEqual(2);
  });
});
