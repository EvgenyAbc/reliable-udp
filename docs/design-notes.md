# Design Notes

## Goals

- Reliable delivery over unordered datagram links.
- Low overhead for real-time applications.
- Channel-based multiplexing with ordered/unordered semantics.

## Protocol shape

- 16-byte fixed header with sequence/ack fields.
- Optional SACK bitmap for sparse acknowledgment.
- NACK hint packets for fast retransmit.
- Fragmentation fields for oversized payloads.

## Reliability strategy

- Sender tracks pending packets and retransmit timers.
- Receiver advances cumulative ACK and advertises sparse receipt via SACK.
- Retransmit on timeout or explicit NACK.

## Congestion model

- NewReno-style cwnd/ssthresh behavior with simple RTT/RTO estimation.
- Intended as a practical baseline, not a full TCP-equivalent stack.

## Tradeoffs

- Simplicity and readability over maximizing throughput in every edge case.
- No encryption or auth in core library; security belongs to outer transport/session layers.
