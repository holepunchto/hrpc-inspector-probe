// Per-peer wall-clock offset estimation over the P2P channel (NTP-style).
//
// INVARIANT 2: NEVER overwrite raw timestamps. normalize() returns
// the raw `ts` and derived `tsNormalized` side by side, plus the offset used.
//
// Verified in verification/clock-skew.test.mjs: under asymmetric routing the
// LOWEST-RTT sample suffers least asymmetry distortion and is the PRIMARY
// estimator; median-of-N is the FALLBACK, used only when RTT variance is low
// (little to gain from picking a single sample, and median denoises jitter).
//
// The offset is defined as (peerClock - localClock). To place a raw peer
// timestamp on the local timeline: tsNormalized = ts - offset.

import type { PeerId } from 'hrpc-inspector-protocol';

/** One four-timestamp probe exchange:
 *  t0 = local send, t1 = remote recv, t2 = remote send, t3 = local recv. */
export interface RttSample {
  t0: number;
  t1: number;
  t2: number;
  t3: number;
  /** (peerClock - localClock) implied by this exchange, in ms. */
  offset: number;
  /** Round-trip time excluding remote processing, in ms. */
  rtt: number;
  /** Local time (t3) the sample completed — used for windowing / cadence. */
  at: number;
}

export type OffsetMethod = 'lowest-rtt' | 'median';

export interface OffsetEstimate {
  /** peerClock - localClock, in ms. */
  offset: number;
  method: OffsetMethod;
  /** RTT the estimate rests on (the minimum, for lowest-rtt). */
  rttMs: number;
  sampleCount: number;
  /** Local time this estimate was computed (drives the 30s re-estimate cadence). */
  computedAt: number;
}

export interface NormalizedTs {
  /** RAW sender wall clock — NEVER overwritten. */
  ts: number;
  /** ts mapped onto the local timeline (ts - offset). For SPACING only. */
  tsNormalized: number;
  offset: number;
  method: OffsetMethod;
}

/** Classic NTP four-timestamp offset + RTT. */
export function offsetFromTimestamps(
  t0: number,
  t1: number,
  t2: number,
  t3: number,
): RttSample {
  return {
    t0,
    t1,
    t2,
    t3,
    offset: (t1 - t0 + (t2 - t3)) / 2,
    rtt: t3 - t0 - (t2 - t1),
    at: t3,
  };
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function stddev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}

export interface EstimatorOptions {
  /** Number of most-recent samples retained (the "N"). Default 8 (C7/C8). */
  windowN?: number;
  /** Re-estimate cadence in ms. Default 30_000 (30s). */
  reestimateIntervalMs?: number;
  /** RTT stddev (ms) at or below which we fall back to median. Default 8. */
  rttStddevThresholdMs?: number;
}

const DEFAULTS: Required<EstimatorOptions> = {
  windowN: 8,
  reestimateIntervalMs: 30_000,
  rttStddevThresholdMs: 8,
};

export class PeerOffsetEstimator {
  readonly peer: PeerId;
  private readonly samples: RttSample[] = [];
  private readonly opts: Required<EstimatorOptions>;
  private cached: OffsetEstimate | null = null;

  constructor(peer: PeerId, opts: EstimatorOptions = {}) {
    this.peer = peer;
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Ingest a completed probe exchange. Oldest is evicted past windowN. */
  addSample(s: RttSample): void {
    this.samples.push(s);
    if (this.samples.length > this.opts.windowN) this.samples.shift();
  }

  /** The current rolling window (most recent last). */
  get window(): readonly RttSample[] {
    return this.samples;
  }

  /** Recompute now, ignoring the 30s cadence, and cache the result. */
  reestimate(now: number = Date.now()): OffsetEstimate {
    if (this.samples.length === 0) {
      throw new Error(`no samples for peer ${this.peer}`);
    }
    const offsets = this.samples.map((x) => x.offset);
    const rtts = this.samples.map((x) => x.rtt);
    const rttStddev = stddev(rtts);

    let method: OffsetMethod;
    let offset: number;
    let rttMs: number;
    if (rttStddev <= this.opts.rttStddevThresholdMs) {
      // Low RTT variance: paths look stable; median denoises jitter (C8 fallback).
      method = 'median';
      offset = median(offsets);
      rttMs = median(rtts);
    } else {
      // High RTT variance (jitter / asymmetry likely): the lowest-RTT sample
      // suffers the least asymmetry distortion (C8 primary).
      const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      method = 'lowest-rtt';
      offset = best.offset;
      rttMs = best.rtt;
    }
    this.cached = {
      offset,
      method,
      rttMs,
      sampleCount: this.samples.length,
      computedAt: now,
    };
    return this.cached;
  }

  /** Cached estimate, recomputed only when the 30s window has elapsed. */
  estimate(now: number = Date.now()): OffsetEstimate {
    if (
      this.cached === null ||
      now - this.cached.computedAt >= this.opts.reestimateIntervalMs
    ) {
      return this.reestimate(now);
    }
    return this.cached;
  }

  /** Map a RAW remote wall clock onto the local timeline. Raw `ts` preserved. */
  normalize(ts: number, now: number = Date.now()): NormalizedTs {
    const e = this.estimate(now);
    return { ts, tsNormalized: ts - e.offset, offset: e.offset, method: e.method };
  }
}
