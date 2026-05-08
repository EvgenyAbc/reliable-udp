# Ping-Pong Operations and Benchmarks

## Run
- Server: `npm --prefix examples run game:server`
- Client: `npm --prefix examples run game:client -- 127.0.0.1 7777 playerA`
- Benchmark scenarios: `npm --prefix examples run game:benchmark`

## Telemetry
- Server prints every ~2s:
  - tick drift p50/p95/max
  - update duration p50/p95/max
  - outbound bytes/count by message type
- Client prints every ~2s:
  - correction count/snaps and correction p95/max (pixels)
  - render dt mean/stddev
  - inbound bytes/count by message type

## Network Profiles
`network-emulator.ts` supports:
- `lan` (very low latency/jitter/loss)
- `moderate` (playable internet-like)
- `harsh` (high jitter/loss)

Run: `npm --prefix examples exec tsx network-emulator.ts moderate`

## Protocol + Compatibility
- `PING_PONG_PROTOCOL_VERSION` is enforced at join.
- Server replies with `versionMismatch` for incompatible clients.
- Hot messages (`ballEvent`, `inputEvent`, `join`, `input`) use compact binary encoding.
- Remaining messages continue to use JSON payloads.

## Tunables
All are optional environment variables:
- `PING_PONG_INITIAL_RTT_MS`
- `PING_PONG_INITIAL_CWND`
- `PING_PONG_RTO_MULTIPLIER`
- `PING_PONG_MAX_RETRANSMITS`
- `PING_PONG_SACK_BITS`
- `PING_PONG_FRAGMENT_TIMEOUT_MS`
- `PING_PONG_ACK_DELAY_MS`

## Acceptance Checklist
- Two clients can join, start, and play continuously.
- Score/reset and paddle bounds remain correct.
- Under moderate/harsh scenarios, corrections remain bounded and no lockups occur.
- Protocol mismatch is rejected cleanly with `versionMismatch`.
