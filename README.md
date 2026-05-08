# reliable-udp

![Build](https://img.shields.io/badge/build-configure%20CI-blue)
![Coverage](https://img.shields.io/badge/coverage-add%20reporting-blue)
![License](https://img.shields.io/badge/license-MIT-green)

Reliable UDP transport for Node.js applications that need:

- reliable delivery over datagrams
- ordered channels for selective streams
- SACK/NACK-driven recovery
- payload fragmentation and reassembly
- basic congestion control

## Install

```bash
npm install reliable-udp
```

## Quick Start

```ts
import { Buffer } from "node:buffer";
import { ReliableUdpConnection, defaultProtocolConfig } from "reliable-udp";

const outgoing: Buffer[] = [];
const connA = new ReliableUdpConnection(defaultProtocolConfig, (wire) => {
  outgoing.push(Buffer.from(wire));
});
const connB = new ReliableUdpConnection(defaultProtocolConfig, () => {});

connB.on("message", (event) => {
  console.log(
    event.channel,
    event.reliable,
    event.ordered,
    event.data.toString(),
  );
});

connA.sendReliable(1, Buffer.from("hello"), true);
while (outgoing.length > 0) {
  connB.receive(outgoing.shift()!);
}
```

## Public API

Stable exports are re-exported from `src/index.ts`:

- `ReliableUdpConnection`
- `defaultProtocolConfig`, `ProtocolConfig`
- `FLAGS`, `MessageType`
- `NetworkEmulator`
- lower-level protocol primitives (`Packet`, `ReliableSendQueue`, `ReliableReceiveQueue`, `FragmentReassembler`, `CongestionControl`)

## Usage Patterns

### Reliable ordered stream

- use `sendReliable(channel, payload, true)`
- subscribe to `"message"` events

### Unreliable fire-and-forget

- use `sendUnreliable(channel, payload)` for transient state updates

### Config tuning

Common knobs from `ProtocolConfig`:

- `maxPacketSize`: transport MTU budget
- `sackBitmapBits`: selective-ack window
- `ackDelayMs`: ACK batching delay
- `maxRetransmits`: retry ceiling per packet

## Reliability Model

- Receiver sends cumulative ACK plus optional SACK bitmap.
- Sender tracks pending packets, retransmits on timeout or NACK.
- Missing sequence gaps can trigger NACK hints.
- Fragmented payloads are reassembled with timeout cleanup.

## Limitations

- Security/encryption is not built in.
- Congestion algorithm is lightweight and tuned for simplicity.
- No built-in socket adapter; wire `transport` and `receive` to your own UDP or RTC layer.

## Development

```bash
npm install
npm run verify
```

`verify` runs lint, typecheck, and build for the source package.

## Ping Pong LAN Demo

This repository includes a simple authoritative multiplayer ping pong demo using `@kmamal/sdl`.

[video example](examples/ping-pong/video/input.mp4)

![video example](examples/ping-pong/video/output.webp)

Server:

```bash
npm --prefix examples run game:server
```

Client (local):

```bash
npm --prefix examples run game:client -- 127.0.0.1 7777 player1
```

Client (LAN):

```bash
npm --prefix examples run game:client -- <server-ip> 7777 player2
```

Gameplay starts automatically when the second client joins.

## Physics Sandbox Demo

Authoritative multiplayer sandbox using **Matter.js**: gravity, dynamic boxes, WASD/arrow movement on unreliable input, click-to-spawn boxes over reliable messages (see [`examples/physics-sandbox/`](./examples/physics-sandbox/)).

Server:

```bash
npm --prefix examples run physics:server
```

Client (defaults to port `7778`):

```bash
npm --prefix examples run physics:client -- 127.0.0.1 7778 player1
```

## Project docs

- [Contributing](./CONTRIBUTING.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Design Notes](./docs/design-notes.md)
- [Benchmarking and Positioning](./docs/benchmarking.md)
- [Releasing](./RELEASING.md)
