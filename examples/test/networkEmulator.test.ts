import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { NetworkEmulator } from "reliable-udp";

class TestScheduler {
  private now = 0;
  private queue: Array<{ at: number; run: () => void }> = [];

  schedule = (delayMs: number, run: () => void): void => {
    this.queue.push({ at: this.now + delayMs, run });
  };

  flush(): void {
    this.queue.sort((a, b) => a.at - b.at);
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.now = next.at;
      next.run();
    }
  }
}

describe("NetworkEmulator", () => {
  it("can deterministically drop packets with injected rng", () => {
    const scheduler = new TestScheduler();
    const rngValues = [0.0, 0.9];
    const emu = new NetworkEmulator({
      rng: () => rngValues.shift() ?? 1,
      schedule: scheduler.schedule,
    });
    emu.lossRate = 0.5;
    emu.jitterMs = 0;

    let delivered = 0;
    emu.send(Buffer.from("a"), () => {
      delivered += 1;
    });
    emu.send(Buffer.from("b"), () => {
      delivered += 1;
    });
    scheduler.flush();

    expect(delivered).toBe(1);
  });

  it("can deterministically duplicate packets", () => {
    const scheduler = new TestScheduler();
    const rngValues = [0.9, 0.0, 0.0];
    const emu = new NetworkEmulator({
      rng: () => rngValues.shift() ?? 1,
      schedule: scheduler.schedule,
    });
    emu.lossRate = 0;
    emu.jitterMs = 10;
    emu.duplicateRate = 0.5;

    const delivered: string[] = [];
    emu.send(Buffer.from("x"), (buf) => {
      delivered.push(buf.toString());
    });
    scheduler.flush();

    expect(delivered).toEqual(["x", "x"]);
  });
});
