// L1 -> L2 seam. Adapters build against THIS interface, not against the
// collector's ring buffer, so the two sides stay independent: L2 implements
// EventSink; L1 never imports L2's internals.
//
// Every adapter emits the SAME event shape regardless of transport (`type`,
// `peerId`, `t`, plus transport-specific fields). That uniformity is what lets
// one panel render everything.

/** L2-lifecycle event union. Adapters MUST only ever emit one of these `type`s. */
export type L2EventType =
  | 'request.start'
  | 'message.out'
  | 'request.end'
  | 'message.in'
  | 'send.error'
  | 'backpressure.clear'
  | 'conn.state'
  | 'conn.stats'
  | 'ws.open.attempt'
  | 'ws.open'
  | 'ws.close'
  | 'ws.error'
  | 'ws.message.out'
  | 'ws.message.in';

/**
 * Generic L2 event. Deliberately loose (`Record<string, unknown>`-ish via index
 * signature) because the four adapters share a spine (`type`, `peerId`, `t`) but
 * differ in payload — e.g. `bufferedAmount` only makes sense for a DataChannel.
 * L2 owns strict per-type narrowing if/when it wants it; L1's contract is just
 * "every event has at least these three fields."
 */
export interface L2Event {
  type: L2EventType;
  /** Wall-clock-agnostic monotonic timestamp from the probe's `now()` (default `performance.now()`). */
  t: number;
  peerId?: string;
  msgId?: string;
  corrId?: string;
  method?: string;
  transport?: string;
  bytes?: number;
  bufferedAmount?: number;
  senderTs?: number;
  hlc?: string;
  error?: string;
  event?: string;
  ice?: string;
  conn?: string;
  stats?: unknown;
  url?: string;
  code?: number;
  reason?: string;
  [extra: string]: unknown;
}

/**
 * Minimal sink contract. L2's ring buffer/correlator/batcher implements this;
 * L1 never sees or depends on that implementation (Phase 2 parallel build).
 */
export interface EventSink {
  emit(event: L2Event): void;
}

/**
 * Never let a sink's own bug crash the transport it is observing (invariant 3).
 * Every adapter MUST route emits through this, not call `sink.emit` directly.
 */
export function emitSafe(sink: EventSink | undefined | null, event: L2Event): void {
  if (!sink) return;
  try {
    sink.emit(event);
  } catch {
    // Swallow. A monitoring layer must not be able to crash the app it monitors.
  }
}
