import { describe, expect, it } from "vitest";
import * as api from "reliable-udp";

describe("public API", () => {
  it("exports stable entry points", () => {
    expect(typeof api.ReliableUdpConnection).toBe("function");
    expect(typeof api.NetworkEmulator).toBe("function");
    expect(typeof api.Packet).toBe("function");
    expect(typeof api.defaultProtocolConfig).toBe("object");
    expect(typeof api.FLAGS).toBe("object");
  });
});
