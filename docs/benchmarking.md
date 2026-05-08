# Benchmarking and Positioning

## Positioning

`reliable-udp` targets applications that need:
- selective reliability with channel separation
- explicit control over fragmentation/retransmit behavior
- a TypeScript-first implementation that is easy to inspect and adapt

## Suggested benchmark dimensions

- Message delivery latency under configured loss/jitter.
- Recovery time after burst packet loss.
- Throughput for mixed reliable/unreliable traffic.
- CPU overhead of ACK/SACK processing.

## Comparison rubric

When comparing alternatives, use the same workload profile:
- payload sizes
- packet send rates
- loss/jitter patterns
- reliable-to-unreliable ratio

Focus on behavior and predictability under degraded conditions, not only peak throughput.
