import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { FragmentReassembler, defaultProtocolConfig } from "reliable-udp";

describe("FragmentReassembler", () => {
  it("reassembles out-of-order fragments", () => {
    const f = new FragmentReassembler(defaultProtocolConfig);
    const meta = { channel: 0, flags: 0 };
    const a = f.addFragment(1, 2, 3, Buffer.from("c"), meta);
    expect(a).toBeNull();
    const b = f.addFragment(1, 0, 3, Buffer.from("a"), meta);
    expect(b).toBeNull();
    const c = f.addFragment(1, 1, 3, Buffer.from("b"), meta);
    expect(c).not.toBeNull();
    expect(c!.buffer.toString()).toBe("abc");
  });
});
