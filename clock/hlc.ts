// Hybrid Logical Clock — the ORDERING authority for the multi-peer timeline.
//
// INVARIANT 1: HLC wins for ORDERING. The corrected wall clock
// (offset.ts) is used ONLY for SPACING. When the two disagree, ordering follows
// HLC. Two phones can differ by seconds; a raw merged timeline shows responses
// arriving before their requests. HLC removes that lie.
//
// Semantics here are byte-for-byte the algorithm proven in verification/
// clock.test.mjs. Do not "tidy"
// the counter rules without re-running the causality control.

/** Decomposed HLC. Wire form is the string "phys:ctr:node" (P2PEnvelope.hlc). */
export interface HlcTime {
  /** Physical component (epoch ms): a monotonic ceiling over observed clocks. */
  l: number;
  /** Logical counter — breaks ties while the physical component is unchanged. */
  c: number;
  /** Node id (peer). Final, deterministic tiebreak so the order is total. */
  id: string;
}

/** Injectable wall-clock source (epoch ms). Defaults to Date.now. */
export type ClockFn = () => number;

/** Serialize to the frozen wire form "phys:ctr:node" (see hrpc-inspector-protocol). */
export function serializeHlc(t: HlcTime): string {
  return `${t.l}:${t.c}:${t.id}`;
}

/** Parse the wire form. The node id may itself contain ':' — only the first two
 *  separators are structural. Throws on a malformed string. */
export function parseHlc(s: string): HlcTime {
  const i = s.indexOf(':');
  const j = s.indexOf(':', i + 1);
  if (i < 0 || j < 0) throw new Error(`malformed HLC '${s}'`);
  const l = Number(s.slice(0, i));
  const c = Number(s.slice(i + 1, j));
  const id = s.slice(j + 1);
  if (!Number.isFinite(l) || !Number.isFinite(c) || id === '') {
    throw new Error(`malformed HLC '${s}'`);
  }
  return { l, c, id };
}

/** Total order: physical, then counter, then node id. Accepts objects or wire
 *  strings on either side. Negative / zero / positive like a comparator. */
export function compareHlc(a: HlcTime | string, b: HlcTime | string): number {
  const x = typeof a === 'string' ? parseHlc(a) : a;
  const y = typeof b === 'string' ? parseHlc(b) : b;
  return x.l - y.l || x.c - y.c || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
}

export class HybridLogicalClock {
  l = 0;
  c = 0;
  readonly id: string;
  private readonly now: ClockFn;

  constructor(nodeId: string, clockFn: ClockFn = () => Date.now()) {
    this.id = nodeId;
    this.now = clockFn;
  }

  private snapshot(): HlcTime {
    return { l: this.l, c: this.c, id: this.id };
  }

  /** Stamp an outbound message. The physical component is a monotonic ceiling,
   *  so a wall clock that JUMPS BACKWARD (NTP step, bad RTC) cannot rewind it. */
  send(): HlcTime {
    const pt = this.now();
    const lPrev = this.l;
    this.l = Math.max(lPrev, pt);
    this.c = this.l === lPrev ? this.c + 1 : 0;
    return this.snapshot();
  }

  /** Local internal event with no message. Same advance rule as send(). */
  update(): HlcTime {
    return this.send();
  }

  /** Merge a received message's HLC and advance past it. Accepts the decomposed
   *  object or the "phys:ctr:node" wire string carried on the envelope. */
  recv(remote: HlcTime | string): HlcTime {
    const m = typeof remote === 'string' ? parseHlc(remote) : remote;
    const pt = this.now();
    const lPrev = this.l;
    this.l = Math.max(lPrev, m.l, pt);
    if (this.l === lPrev && this.l === m.l) this.c = Math.max(this.c, m.c) + 1;
    else if (this.l === lPrev) this.c = this.c + 1;
    else if (this.l === m.l) this.c = m.c + 1;
    else this.c = 0;
    return this.snapshot();
  }

  /** Current value without advancing. */
  peek(): HlcTime {
    return this.snapshot();
  }
}
