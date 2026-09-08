// L2 side of the L1->L2 seam. probe-engineer owns the canonical `EventSink` /
// `L2Event` contract in ../src/sink.ts; this is L2's implementation of it. L1
// adapters emit `L2Event`s (via `emitSafe`) and never see the ring buffer,
// correlator or batcher behind this class.
//
// RECONCILIATION (done): earlier this file defined a placeholder
// `EventSink { emit(P2PEnvelope) }`. probe-engineer's real contract has landed at
// ../src/sink.ts, so we now implement THAT and re-export it. The event shape is
// their lifecycle union (`request.start`, `request.end`, `message.in`, ...),
// keyed on `corrId` — not raw `P2PEnvelope`.

import { Collector } from './correlator.ts';
import type { CollectorOptions } from './correlator.ts';
import type { EventSink, L2Event } from '../src/sink.ts';

export type { EventSink, L2Event, L2EventType } from '../src/sink.ts';
export { emitSafe } from '../src/sink.ts';

export interface CollectorSinkOptions extends CollectorOptions {
  /**
   * Time source for correlation. L2Events carry a monotonic `t` from the probe's
   * `now()`; by default we correlate in that domain. Override to remap (e.g. into
   * an HLC/offset-corrected domain from hrpc-inspector-probe/clock).
   */
  now?: (event: L2Event) => number;
}

/**
 * An `EventSink` that routes L1 lifecycle events into a `Collector`.
 *
 * Event mapping:
 *   - `request.start`         -> register/extend a pending request. Repeated
 *                                starts for one corrId accumulate fan-out peers
 *                                (one request -> N peers), so a broadcast that
 *                                announces each target as it dispatches builds
 *                                the correct awaited set.
 *   - `request.end`/`message.in` -> a correlated response from `peerId`.
 *   - `send.error`            -> a terminal error response; it settles the peer
 *                                so the request does not falsely time out, and
 *                                is a tail-sampling keep reason downstream.
 *   - everything else         -> not correlated (raw byte/conn telemetry).
 *
 * Unanswered requests are surfaced by the caller invoking `sweep` (invariant #3).
 */
export class CollectorSink implements EventSink {
  readonly collector: Collector;
  private readonly now: (event: L2Event) => number;

  constructor(options: CollectorSinkOptions = {}) {
    const { now, ...collectorOptions } = options;
    this.collector = new Collector(collectorOptions);
    this.now = now ?? ((e) => e.t);
  }

  emit(event: L2Event): void {
    const corrId = event.corrId;
    if (!corrId) return; // uncorrelated telemetry — nothing for L2 to correlate
    const t = this.now(event);

    switch (event.type) {
      case 'request.start': {
        const peer = event.peerId;
        const existing = this.collector.pending.get(corrId);
        if (existing) {
          // Fan-out: add this target to the awaited set of the live request.
          if (peer) existing.awaiting.add(peer);
        } else {
          this.collector.request(corrId, event.method ?? '(unknown)', peer ? [peer] : [], t);
        }
        break;
      }
      case 'request.end':
      case 'message.in': {
        if (event.peerId) this.collector.response(corrId, event.peerId, t);
        break;
      }
      case 'send.error': {
        // Terminal for this peer: settle it so the request isn't falsely timed
        // out on a peer we already know failed.
        if (event.peerId) this.collector.response(corrId, event.peerId, t);
        break;
      }
      default:
        // message.out / conn.* / ws.* / stats — not correlated here.
        break;
    }
  }

  /** Sweep pending requests older than the collector's timeout into timeout rows. */
  sweep(now: number): void {
    this.collector.sweep(now);
  }
}
