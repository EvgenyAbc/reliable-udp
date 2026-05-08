import dgram, { type RemoteInfo } from "node:dgram";
import { Buffer } from "node:buffer";
import {
  ReliableUdpConnection,
  defaultProtocolConfig,
  type ProtocolConfig,
} from "reliable-udp";

export interface Endpoint {
  host: string;
  port: number;
}

export interface ServerPeer {
  id: string;
  endpoint: Endpoint;
  connection: ReliableUdpConnection;
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function createPingPongProtocolConfig(): Partial<ProtocolConfig> {
  const out: Partial<ProtocolConfig> = {};
  const entries: Array<[keyof ProtocolConfig, string]> = [
    ["initialRttMs", "PING_PONG_INITIAL_RTT_MS"],
    ["initialCwnd", "PING_PONG_INITIAL_CWND"],
    ["retransmitTimeoutMultiplier", "PING_PONG_RTO_MULTIPLIER"],
    ["maxRetransmits", "PING_PONG_MAX_RETRANSMITS"],
    ["sackBitmapBits", "PING_PONG_SACK_BITS"],
    ["fragmentAssemblyTimeoutMs", "PING_PONG_FRAGMENT_TIMEOUT_MS"],
    ["ackDelayMs", "PING_PONG_ACK_DELAY_MS"],
  ];
  for (const [key, env] of entries) {
    const value = envNumber(env);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function peerKey(rinfo: RemoteInfo): string {
  return `${rinfo.address}:${rinfo.port}`;
}

export function createServerAdapter(
  port: number,
  onPeer: (peer: ServerPeer) => void,
  config?: Partial<ProtocolConfig>,
): dgram.Socket {
  const socket = dgram.createSocket("udp4");
  const peers = new Map<string, ServerPeer>();

  socket.on("message", (msg, rinfo) => {
    const id = peerKey(rinfo);
    let peer = peers.get(id);
    if (!peer) {
      const endpoint = { host: rinfo.address, port: rinfo.port };
      const connection = new ReliableUdpConnection(
        { ...defaultProtocolConfig, ...config },
        (wire) => {
          socket.send(wire, endpoint.port, endpoint.host);
        },
      );
      peer = { id, endpoint, connection };
      peers.set(id, peer);
      onPeer(peer);
    }
    peer.connection.receive(Buffer.from(msg));
  });

  socket.bind(port, "0.0.0.0");
  return socket;
}

export function createClientAdapter(
  server: Endpoint,
  config?: Partial<ProtocolConfig>,
): { socket: dgram.Socket; connection: ReliableUdpConnection } {
  const socket = dgram.createSocket("udp4");
  const connection = new ReliableUdpConnection(
    { ...defaultProtocolConfig, ...config },
    (wire) => {
      socket.send(wire, server.port, server.host);
    },
  );

  socket.on("message", (msg) => {
    connection.receive(Buffer.from(msg));
  });

  socket.bind(0, "0.0.0.0");
  return { socket, connection };
}
