/** Bit flags for packet header (project.md §3). */
export const FLAGS = {
  RELIABLE: 1 << 0,
  ORDERED: 1 << 1,
  ACK: 1 << 2,
  NACK: 1 << 3,
  FRAGMENTED: 1 << 4,
  HAS_SACK: 1 << 5,
} as const;

export type Flags = number;

export interface ProtocolConfig {
  /** Max UDP payload (e.g. MTU − headers). */
  maxPacketSize: number;
  initialRttMs: number;
  initialCwnd: number;
  retransmitTimeoutMultiplier: number;
  maxRetransmits: number;
  /** SACK bitmap size in bits (multiple of 8). */
  sackBitmapBits: number;
  /** Max fragments per logical message. */
  maxFragments: number;
  /** Reassembly timeout (ms). */
  fragmentAssemblyTimeoutMs: number;
  /** Coalesce ACKs up to this delay (ms); 0 = send immediately. */
  ackDelayMs: number;
}

export const defaultProtocolConfig: ProtocolConfig = {
  maxPacketSize: 1452,
  initialRttMs: 100,
  initialCwnd: 10,
  retransmitTimeoutMultiplier: 2,
  maxRetransmits: 10,
  sackBitmapBits: 256,
  maxFragments: 255,
  fragmentAssemblyTimeoutMs: 5000,
  ackDelayMs: 20,
};

export enum MessageType {
  GameStateDelta = 0,
  Input = 1,
  ReliableEvent = 2,
  Ping = 3,
}

export const HEADER_SIZE = 16;
export const SACK_BYTES_DEFAULT = 32;
