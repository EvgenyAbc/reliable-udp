import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { ReliableUdpConnection, defaultProtocolConfig } from "reliable-udp";

function duplexPair() {
  const aToB: Buffer[] = [];
  const bToA: Buffer[] = [];
  const cfg = { ...defaultProtocolConfig, ackDelayMs: 0, maxPacketSize: 512 };
  const a = new ReliableUdpConnection(cfg, (buf) => {
    aToB.push(Buffer.from(buf));
  });
  const b = new ReliableUdpConnection(cfg, (buf) => {
    bToA.push(Buffer.from(buf));
  });
  function drain() {
    while (aToB.length > 0 || bToA.length > 0) {
      while (aToB.length > 0) {
        b.receive(aToB.shift()!);
      }
      while (bToA.length > 0) {
        a.receive(bToA.shift()!);
      }
    }
  }
  return { a, b, drain };
}

describe("ReliableUdpConnection", () => {
  it("delivers reliable ordered messages over loopback", () => {
    const { a, b, drain } = duplexPair();
    const got: string[] = [];
    b.on("message", (ev) => {
      got.push(ev.data.toString());
    });
    expect(a.sendReliable(1, Buffer.from("hello"))).toBe(true);
    drain();
    expect(got).toEqual(["hello"]);
  });

  it("acks reliable sends so sender clears pending", () => {
    const { a, drain } = duplexPair();
    let acked = false;
    expect(
      a.sendReliable(1, Buffer.from("x"), true, () => {
        acked = true;
      }),
    ).toBe(true);
    drain();
    expect(acked).toBe(true);
    expect(a.getCongestion().getRttMs()).toBeGreaterThan(0);
  });

  it("fragments large reliable payloads", () => {
    const { a, b, drain } = duplexPair();
    const got: Buffer[] = [];
    b.on("message", (ev) => {
      got.push(ev.data);
    });
    const big = Buffer.alloc(900, 7);
    expect(a.sendReliable(0, big)).toBe(true);
    drain();
    expect(got).toHaveLength(1);
    expect(got[0]!.length).toBe(900);
    expect(got[0]![0]).toBe(7);
  });

  it("recovers from initial packet loss via retransmit", async () => {
    const aToB: Buffer[] = [];
    const bToA: Buffer[] = [];
    const cfg = {
      ...defaultProtocolConfig,
      ackDelayMs: 0,
      maxPacketSize: 512,
      initialRttMs: 2,
      retransmitTimeoutMultiplier: 1,
    };
    let dropFirst = true;
    const a = new ReliableUdpConnection(cfg, (buf) => {
      if (dropFirst) {
        dropFirst = false;
        return;
      }
      aToB.push(Buffer.from(buf));
    });
    const b = new ReliableUdpConnection(cfg, (buf) => {
      bToA.push(Buffer.from(buf));
    });
    const got: string[] = [];
    b.on("message", (ev) => {
      got.push(ev.data.toString());
    });

    expect(a.sendReliable(1, Buffer.from("retry-me"))).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    while (aToB.length > 0 || bToA.length > 0) {
      while (aToB.length > 0) b.receive(aToB.shift()!);
      while (bToA.length > 0) a.receive(bToA.shift()!);
    }

    expect(got).toEqual(["retry-me"]);
  });
});
