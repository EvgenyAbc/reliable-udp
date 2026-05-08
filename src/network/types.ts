import type { Buffer } from "node:buffer";

/** Pluggable datagram send (UDP, RTCDataChannel, tests). */
export type DatagramSender = (packet: Buffer) => void;
