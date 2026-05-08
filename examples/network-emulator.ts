import { Buffer } from "node:buffer";
import {
  NetworkEmulator,
  ReliableUdpConnection,
  defaultProtocolConfig,
} from "reliable-udp";

type ProfileName = "lan" | "moderate" | "harsh";
const profile = (process.argv[2] as ProfileName | undefined) ?? "moderate";
const profiles: Record<ProfileName, { latencyMs: number; jitterMs: number; lossRate: number }> =
  {
    lan: { latencyMs: 3, jitterMs: 1, lossRate: 0 },
    moderate: { latencyMs: 20, jitterMs: 15, lossRate: 0.1 },
    harsh: { latencyMs: 60, jitterMs: 45, lossRate: 0.2 },
  };
const selected = profiles[profile] ?? profiles.moderate;

const emulatorAB = new NetworkEmulator();
const emulatorBA = new NetworkEmulator();
emulatorAB.latencyMs = selected.latencyMs;
emulatorAB.jitterMs = selected.jitterMs;
emulatorAB.lossRate = selected.lossRate;
emulatorBA.latencyMs = selected.latencyMs;
emulatorBA.jitterMs = selected.jitterMs;
emulatorBA.lossRate = selected.lossRate;

let a!: ReliableUdpConnection;
let b!: ReliableUdpConnection;

a = new ReliableUdpConnection(defaultProtocolConfig, (wire) => {
  emulatorAB.send(wire, (buf) => b.receive(Buffer.from(buf)));
});
b = new ReliableUdpConnection(defaultProtocolConfig, (wire) => {
  emulatorBA.send(wire, (buf) => a.receive(Buffer.from(buf)));
});

b.on("message", (event) => {
  console.log(`[${profile}] received: ${event.data.toString()}`);
});

a.sendReliable(0, Buffer.from("reliable packet through lossy emulated network"));
