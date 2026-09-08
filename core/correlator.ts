// L2 request/response correlator. This is the layer the product exists for:
// a P2P request that vanishes must NOT vanish from the UI — it must surface as a
// `timeout` row naming the silent peer (invariant #3). Late responses arriving
// after that timeout are counted for diagnostics but never resurrect the row or
// double-count it (invariant #4).
//
// Fan-out model: one request -> N peers -> M responses (M <= N). The request
// settles when every awaited peer has answered; if the sweep fires first, the
// still-awaited peers are named in the timeout row.

import { RingBuffer } from './ring-buffer.ts';
import type { PeerId } from 'hrpc-inspector-protocol/envelope';

export type RowKind = 'req' | 'res' | 'timeout';

export interface CollectorRow {
  kind: RowKind;
  corrId: string;
  t: number;
  method?: string;
  /** req only: number of peers the request fanned out to. */
  fanout?: number;
  /** res only. */
  peer?: PeerId;
  /** res / (implied) — round-trip time in the same clock domain as `t`. */
  rtt?: number;
  /** timeout only: peers that never answered. Names the silent peer(s). */
  unanswered?: PeerId[];
  /** timeout only: how many of the fan-out DID answer before the deadline. */
  partial?: number;
}

export interface PendingRequest {
  method: string;
  /** Request send time, in the collector's clock domain. */
  t: number;
  /** Peers still awaited. Drains to empty as responses arrive. */
  awaiting: Set<PeerId>;
  responses: Array<{ peer: PeerId; rtt: number }>;
}

export interface CollectorOptions {
  /** Ring-buffer cap for emitted rows. Hard memory bound. */
  maxEvents?: number;
  /** Cap on concurrently in-flight requests. Hard memory bound on the pending Map. */
  maxPending?: number;
  /** A request older than this (in the collector clock domain) is swept to a timeout. */
  timeoutMs?: number;
  /**
   * Cap on the "recently settled" set used for late-response detection. Bounded
   * on purpose — an unbounded Set here would leak one entry per settled request
   * forever (invariant #1). We remember only the most recent `maxSettled` corrIds;
   * a response older than that window is simply ignored, which is correct: it is
   * far too late to matter and holding it hostage would be the leak.
   */
  maxSettled?: number;
}

export class Collector {
  readonly events: RingBuffer<CollectorRow>;
  readonly pending = new Map<string, PendingRequest>();
  readonly maxPending: number;
  readonly timeoutMs: number;
  readonly maxSettled: number;

  /** Requests evicted from `pending` because the in-flight cap was hit. Observable. */
  pendingDropped = 0;
  /** Requests swept to a timeout row. Observable. */
  timedOut = 0;
  /** Responses that arrived after their request had already settled/timed out. */
  lateAfterTimeout = 0;

  /** Bounded, insertion-ordered set of recently settled corrIds. */
  private readonly settled = new Set<string>();

  constructor({ maxEvents = 1000, maxPending = 500, timeoutMs = 5000, maxSettled = 4096 }: CollectorOptions = {}) {
    this.events = new RingBuffer<CollectorRow>(maxEvents);
    this.maxPending = maxPending;
    this.timeoutMs = timeoutMs;
    this.maxSettled = maxSettled;
  }

  /**
   * Total observable drops: row-buffer evictions + pending-map evictions. Both
   * are gap-worthy; the UI must not silently omit either (invariant #2).
   */
  get dropped(): number {
    return this.events.dropped + this.pendingDropped;
  }

  private markSettled(corrId: string): void {
    this.settled.add(corrId);
    // Evict oldest settled ids to keep this Set bounded (invariant #1).
    while (this.settled.size > this.maxSettled) {
      const oldest = this.settled.values().next().value as string;
      this.settled.delete(oldest);
    }
  }

  /** Register an outbound request fanning out to `peers`. */
  request(corrId: string, method: string, peers: PeerId[], t: number): void {
    this.pending.set(corrId, { method, t, awaiting: new Set(peers), responses: [] });
    if (this.pending.size > this.maxPending) {
      const oldest = this.pending.keys().next().value as string;
      this.pending.delete(oldest);
      this.pendingDropped++;
    }
    this.events.push({ kind: 'req', corrId, method, t, fanout: peers.length });
  }

  /** Record a response from `peer` for `corrId`. */
  response(corrId: string, peer: PeerId, t: number): void {
    const p = this.pending.get(corrId);
    if (!p) {
      // No live request. Either it already settled/timed out (count as late,
      // invariant #4) or it is unknown to us. Either way: do NOT resurrect a row.
      if (this.settled.has(corrId)) this.lateAfterTimeout++;
      return;
    }
    p.awaiting.delete(peer);
    const rtt = t - p.t;
    p.responses.push({ peer, rtt });
    this.events.push({ kind: 'res', corrId, peer, t, rtt });
    if (p.awaiting.size === 0) {
      this.pending.delete(corrId);
      this.markSettled(corrId);
    }
  }

  /** Sweep pending requests older than `timeoutMs`, emitting timeout rows. */
  sweep(now: number): void {
    for (const [corrId, p] of this.pending) {
      if (now - p.t > this.timeoutMs) {
        this.events.push({
          kind: 'timeout',
          corrId,
          method: p.method,
          t: now,
          unanswered: [...p.awaiting],
          partial: p.responses.length,
        });
        this.pending.delete(corrId);
        this.markSettled(corrId);
        this.timedOut++;
      }
    }
  }

  /** Current size of the bounded recently-settled set (for tests / diagnostics). */
  get settledSize(): number {
    return this.settled.size;
  }
}
