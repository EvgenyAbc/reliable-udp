import {
  CHANNEL_EVENT,
  PING_PONG_PROTOCOL_VERSION,
  decodeServerMessage,
  encodeMessage,
} from "./protocol.js";
import { createClientAdapter, createPingPongProtocolConfig } from "./udpAdapter.js";

const host = process.env.PING_PONG_HOST ?? "127.0.0.1";
const port = Number(process.env.PING_PONG_PORT ?? 7777);
const bots = Number(process.env.PING_PONG_SOAK_BOTS ?? 20);
const durationMs = Number(process.env.PING_PONG_SOAK_MS ?? 15000);
const creatorCount = Math.max(1, Math.floor(bots * 0.35));

type Bot = ReturnType<typeof createClientAdapter>;
const clients: Bot[] = [];
let roomErrors = 0;
let roomJoined = 0;
let roomCreated = 0;
let selfJoinAcks = 0;
const createdRooms: string[] = [];
const errorByCode = new Map<string, number>();

for (let i = 0; i < bots; i++) {
  const client = createClientAdapter({ host, port }, createPingPongProtocolConfig());
  clients.push(client);
  client.connection.on("message", (event) => {
    if (event.channel !== CHANNEL_EVENT) return;
    const msg = decodeServerMessage(event.data);
    if (!msg) return;
    if (msg.type === "roomError") {
      roomErrors += 1;
      errorByCode.set(msg.code, (errorByCode.get(msg.code) ?? 0) + 1);
    } else if (msg.type === "roomJoined") {
      roomJoined += 1;
    } else if (msg.type === "roomCreated") {
      roomCreated += 1;
      createdRooms.push(msg.roomId);
      // Regression probe: host self-join should be an idempotent success path.
      client.connection.sendReliable(
        CHANNEL_EVENT,
        encodeMessage({
          type: "joinRoom",
          roomId: msg.roomId,
          name: `creator-${i}`,
          version: PING_PONG_PROTOCOL_VERSION,
          requestId: `self-join-${i}`,
        }),
        true,
      );
    } else if (msg.type === "roomWaiting") {
      selfJoinAcks += 1;
    }
  });
  if (i < creatorCount) {
    client.connection.sendReliable(
      CHANNEL_EVENT,
      encodeMessage({
        type: "createRoom",
        name: `creator-${i}`,
        version: PING_PONG_PROTOCOL_VERSION,
        requestId: `create-${i}`,
      }),
      true,
    );
  } else {
    setTimeout(() => {
      const target = createdRooms[(i - creatorCount) % Math.max(1, createdRooms.length)];
      client.connection.sendReliable(
        CHANNEL_EVENT,
        encodeMessage({
          type: "joinRoom",
          roomId: target,
          name: `joiner-${i}`,
          version: PING_PONG_PROTOCOL_VERSION,
          requestId: `join-${i}`,
        }),
        true,
      );
    }, 600);
  }
}

setTimeout(() => {
  for (const c of clients) {
    c.connection.sendReliable(
      CHANNEL_EVENT,
      encodeMessage({ type: "quit", requestId: `quit-${Math.random()}` }),
      true,
    );
    c.socket.close();
  }
  console.log(
    `[soak] bots=${bots} creators=${creatorCount} created=${roomCreated} selfJoinAcks=${selfJoinAcks} joined=${roomJoined} errors=${roomErrors} errorCodes=${JSON.stringify(Object.fromEntries(errorByCode.entries()))} durationMs=${durationMs}`,
  );
  process.exit(0);
}, durationMs);

