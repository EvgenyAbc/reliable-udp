import { Buffer } from "node:buffer";
import type { ProtocolConfig } from "./types.js";

type Meta = { channel: number; flags: number };

export interface AssembledMessage {
  buffer: Buffer;
  channel: number;
  flags: number;
}

/**
 * Reassembles fragmented payloads (project.md §4.6).
 */
export class FragmentReassembler {
  private readonly fragments = new Map<number, Map<number, Buffer>>();
  private readonly meta = new Map<number, Meta>();
  private readonly timeouts = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(private readonly config: ProtocolConfig) {}

  addFragment(
    messageId: number,
    fragId: number,
    total: number,
    data: Buffer,
    meta: Meta,
  ): AssembledMessage | null {
    const mid = messageId & 0xffff;
    if (total <= 0 || total > this.config.maxFragments) {
      return null;
    }
    if (fragId < 0 || fragId >= total) {
      return null;
    }
    let map = this.fragments.get(mid);
    if (!map) {
      map = new Map<number, Buffer>();
      this.fragments.set(mid, map);
      const t = setTimeout(() => {
        this.fragments.delete(mid);
        this.meta.delete(mid);
        this.timeouts.delete(mid);
      }, this.config.fragmentAssemblyTimeoutMs);
      this.timeouts.set(mid, t);
    }
    if (fragId === 0) {
      this.meta.set(mid, meta);
    }
    map.set(fragId, data);
    if (map.size < total) {
      return null;
    }
    const assembled = this.concatFragments(map, total);
    const stored = this.meta.get(mid) ?? meta;
    this.fragments.delete(mid);
    this.meta.delete(mid);
    const tt = this.timeouts.get(mid);
    if (tt) clearTimeout(tt);
    this.timeouts.delete(mid);
    return { buffer: assembled, channel: stored.channel, flags: stored.flags };
  }

  private concatFragments(map: Map<number, Buffer>, total: number): Buffer {
    let len = 0;
    for (let i = 0; i < total; i++) {
      const b = map.get(i);
      if (!b) throw new Error("fragment missing");
      len += b.length;
    }
    const out = Buffer.allocUnsafe(len);
    let o = 0;
    for (let i = 0; i < total; i++) {
      const b = map.get(i)!;
      b.copy(out, o);
      o += b.length;
    }
    return out;
  }

  clear(): void {
    for (const t of this.timeouts.values()) clearTimeout(t);
    this.timeouts.clear();
    this.fragments.clear();
    this.meta.clear();
  }
}
