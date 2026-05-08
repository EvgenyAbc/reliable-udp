import { describe, expect, it } from "vitest";
import {
  PING_PONG_PROTOCOL_VERSION,
  decodeClientMessage,
  decodeServerMessage,
  encodeMessage,
} from "../ping-pong/protocol.js";

describe("ping-pong matchmaking protocol", () => {
  it("encodes and decodes createRoom with visibility", () => {
    const payload = encodeMessage({
      type: "createRoom",
      name: "host-a",
      version: PING_PONG_PROTOCOL_VERSION,
      requestId: "r1",
      visibility: "private",
    });
    const decoded = decodeClientMessage(payload);
    expect(decoded?.type).toBe("createRoom");
    if (!decoded || decoded.type !== "createRoom") return;
    expect(decoded.name).toBe("host-a");
  });

  it("decodes lobbyState with versions and room phase", () => {
    const payload = encodeMessage({
      type: "lobbyState",
      lobbyVersion: 10,
      rooms: [
        {
          roomId: "ROOM11",
          hostName: "h",
          connected: 1,
          running: false,
          phase: "open",
          visibility: "public",
          roomVersion: 3,
        },
      ],
      you: {},
    });
    const decoded = decodeServerMessage(payload);
    expect(decoded?.type).toBe("lobbyState");
    if (!decoded || decoded.type !== "lobbyState") return;
    expect(decoded.rooms.length).toBe(1);
    expect(decoded.lobbyVersion).toBe(10);
  });

  it("decodes roomState snapshot", () => {
    const payload = encodeMessage({
      type: "roomState",
      state: {
        roomId: "ROOM22",
        hostName: "host",
        connected: 2,
        running: true,
        phase: "running",
        visibility: "public",
        roomVersion: 8,
        leftScore: 2,
        rightScore: 1,
      },
    });
    const decoded = decodeServerMessage(payload);
    expect(decoded?.type).toBe("roomState");
  });
});
