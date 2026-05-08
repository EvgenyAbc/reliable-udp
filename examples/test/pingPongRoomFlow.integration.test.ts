import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHANNEL_EVENT,
  PING_PONG_PROTOCOL_VERSION,
  type ServerMessage,
  decodeServerMessage,
  encodeMessage,
} from "../ping-pong/protocol.js";
import {
  createClientAdapter,
  createPingPongProtocolConfig,
} from "../ping-pong/udpAdapter.js";

type Bot = ReturnType<typeof createClientAdapter>;

const TEST_TIMEOUT_MS = 3000;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function waitForMessage(
  bot: Bot,
  predicate: (msg: ServerMessage) => boolean,
  timeoutMs = TEST_TIMEOUT_MS,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bot.connection.off("message", onMessage);
      reject(new Error(`timed out waiting for server message (${timeoutMs}ms)`));
    }, timeoutMs);
    const onMessage = (event: { channel: number; data: Buffer }) => {
      if (event.channel !== CHANNEL_EVENT) return;
      const msg = decodeServerMessage(event.data);
      if (!msg || !predicate(msg)) return;
      clearTimeout(timer);
      bot.connection.off("message", onMessage);
      resolve(msg);
    };
    bot.connection.on("message", onMessage);
  });
}

describe.sequential("ping-pong room lifecycle reliability", () => {
  let server: ChildProcessWithoutNullStreams;
  let port = 0;
  const bots: Bot[] = [];

  beforeAll(async () => {
    port = 8900 + randomInt(0, 200);
    server = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "ping-pong/server.ts"], {
      cwd: ROOT,
      env: { ...process.env, PING_PONG_PORT: String(port) },
      stdio: "pipe",
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server startup timeout")), TEST_TIMEOUT_MS);
      server.stdout.on("data", (chunk) => {
        const line = chunk.toString("utf8");
        if (line.includes("ping-pong server listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      server.stderr.on("data", (chunk) => {
        clearTimeout(timer);
        reject(new Error(`server stderr during startup: ${chunk.toString("utf8")}`));
      });
      server.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited during startup with code ${code}`));
      });
    });
  });

  afterAll(async () => {
    for (const bot of bots) {
      bot.socket.close();
    }
    if (server && !server.killed) {
      server.kill("SIGTERM");
      await delay(80);
      if (!server.killed) server.kill("SIGKILL");
    }
  });

  it(
    "keeps self-join idempotent and supports cross-room deterministic joins",
    async () => {
      const hostA = createClientAdapter({ host: "127.0.0.1", port }, createPingPongProtocolConfig());
      const guestA = createClientAdapter({ host: "127.0.0.1", port }, createPingPongProtocolConfig());
      const hostB = createClientAdapter({ host: "127.0.0.1", port }, createPingPongProtocolConfig());
      bots.push(hostA, guestA, hostB);
      await delay(50);

      hostA.connection.sendReliable(
        CHANNEL_EVENT,
        encodeMessage({
          type: "createRoom",
          name: "hostA",
          version: PING_PONG_PROTOCOL_VERSION,
          requestId: "hostA-create",
        }),
        true,
      );
      const hostARoomCreated = await waitForMessage(
        hostA,
        (m) => m.type === "roomCreated" && m.role === "host",
      );
      if (hostARoomCreated.type !== "roomCreated") throw new Error("unexpected message");
      const roomA = hostARoomCreated.roomId;

      hostA.connection.sendReliable(
        CHANNEL_EVENT,
        encodeMessage({
          type: "joinRoom",
          roomId: roomA,
          name: "hostA",
          version: PING_PONG_PROTOCOL_VERSION,
          requestId: "hostA-self-join",
        }),
        true,
      );
      await waitForMessage(hostA, (m) => m.type === "roomWaiting" && m.roomId === roomA);

      guestA.connection.sendReliable(
        CHANNEL_EVENT,
        encodeMessage({
          type: "joinRoom",
          roomId: roomA,
          name: "guestA",
          version: PING_PONG_PROTOCOL_VERSION,
          requestId: "guestA-join-a",
        }),
        true,
      );
      const guestJoinedA = await waitForMessage(
        guestA,
        (m) => m.type === "roomJoined" && m.roomId === roomA,
      );
      expect(guestJoinedA.type).toBe("roomJoined");

      hostB.connection.sendReliable(
        CHANNEL_EVENT,
        encodeMessage({
          type: "createRoom",
          name: "hostB",
          version: PING_PONG_PROTOCOL_VERSION,
          requestId: "hostB-create",
        }),
        true,
      );
      const hostBRoomCreated = await waitForMessage(
        hostB,
        (m) => m.type === "roomCreated" && m.role === "host",
      );
      if (hostBRoomCreated.type !== "roomCreated") throw new Error("unexpected message");
      const roomB = hostBRoomCreated.roomId;

      hostA.connection.sendReliable(
        CHANNEL_EVENT,
        encodeMessage({
          type: "joinRoom",
          roomId: roomB,
          name: "hostA",
          version: PING_PONG_PROTOCOL_VERSION,
          requestId: "hostA-join-b",
        }),
        true,
      );
      const hostAJoinedB = await waitForMessage(
        hostA,
        (m) => m.type === "roomJoined" && m.roomId === roomB,
      );
      if (hostAJoinedB.type !== "roomJoined") throw new Error("unexpected message");
      expect(hostAJoinedB.role).toBe("guest");

      guestA.connection.sendReliable(
        CHANNEL_EVENT,
        encodeMessage({
          type: "joinRoom",
          roomId: roomA,
          name: "guestA",
          version: PING_PONG_PROTOCOL_VERSION,
          requestId: "guestA-join-a-again",
        }),
        true,
      );
      const roomAAfterHostMoved = await waitForMessage(
        guestA,
        (m) => m.type === "roomError" && m.code === "ROOM_NOT_FOUND",
      );
      expect(roomAAfterHostMoved.type).toBe("roomError");
    },
    20000,
  );
});
