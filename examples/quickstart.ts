import { Buffer } from "node:buffer";
import { ReliableUdpConnection, defaultProtocolConfig } from "reliable-udp";

function pump(aToB: Buffer[], bToA: Buffer[], a: ReliableUdpConnection, b: ReliableUdpConnection): void {
  while (aToB.length > 0 || bToA.length > 0) {
    while (aToB.length > 0) b.receive(aToB.shift()!);
    while (bToA.length > 0) a.receive(bToA.shift()!);
  }
}

const aToB: Buffer[] = [];
const bToA: Buffer[] = [];

const sender = new ReliableUdpConnection(defaultProtocolConfig, (wire) => {
  aToB.push(Buffer.from(wire));
});
const receiver = new ReliableUdpConnection(defaultProtocolConfig, (wire) => {
  bToA.push(Buffer.from(wire));
});

receiver.on("message", (event) => {
  console.log(`channel=${event.channel} data=${event.data.toString()}`);
});

sender.sendReliable(1, Buffer.from("hello from reliable-udp"), true);
pump(aToB, bToA, sender, receiver);
