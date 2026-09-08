// Per-peer skew CONFIDENCE INTERVAL — the signal the UI uses to decide whether
// to draw a peer's lane as a precise bar or a hatched (uncertain) band.
//
// INVARIANT 3: surface uncertainty. When confidence is poor the lane
// renders hatched rather than drawing a precise-looking bar. A timeline that
// admits it is unsure beats one that lies.
//
// C8: asymmetric-path error is an algorithmic FLOOR, not a defect. We surface it
// as the interval; we do NOT tune it away. The half-width has two parts:
//
//   floor  = minRtt / 2   — the irreducible NTP asymmetry bound. With no
//            knowledge of path asymmetry the true offset can sit anywhere within
//            ±rtt/2 of the estimate; the lowest RTT gives the tightest floor.
//
//   spread = (max - min of the recent per-sample offsets) / 2 — observed
//            disagreement. Under symmetric routing every sample lands on ~the
//            same offset regardless of its RTT, so spread ≈ 0. Under asymmetric
//            routing the per-sample offset scales with that sample's RTT, so
//            spread grows. This is what makes the interval WIDEN under real
//            asymmetry rather than staying a cosmetic constant.

import type { OffsetEstimate, RttSample } from './offset.ts';

export type Confidence = 'good' | 'fair' | 'poor';

export interface SkewConfidence {
  /** peerClock - localClock, ms (the point estimate). */
  offset: number;
  /** Half-width of the interval, ms. Full CI is offset ± ciHalfWidthMs. */
  ciHalfWidthMs: number;
  ciLowMs: number;
  ciHighMs: number;
  confidence: Confidence;
  /** UI signal: draw the lane hatched instead of a precise bar when true. */
  hatched: boolean;
  method: OffsetEstimate['method'];
  sampleCount: number;
}

export interface SkewOptions {
  /** CI half-width (ms) below/at which confidence is 'good'. Default 12. */
  goodThresholdMs?: number;
  /** CI half-width (ms) above which the lane renders hatched. Default 25. */
  hatchThresholdMs?: number;
}

const DEFAULTS: Required<SkewOptions> = {
  goodThresholdMs: 12,
  hatchThresholdMs: 25,
};

export function skewConfidence(
  estimate: OffsetEstimate,
  window: readonly RttSample[],
  opts: SkewOptions = {},
): SkewConfidence {
  const o = { ...DEFAULTS, ...opts };

  const rtts = window.map((s) => s.rtt);
  const offsets = window.map((s) => s.offset);
  const minRtt = rtts.length ? Math.min(...rtts) : estimate.rttMs;

  const floor = minRtt / 2;
  const spread =
    offsets.length > 1 ? (Math.max(...offsets) - Math.min(...offsets)) / 2 : 0;

  const ciHalfWidthMs = floor + spread;

  const confidence: Confidence =
    ciHalfWidthMs <= o.goodThresholdMs
      ? 'good'
      : ciHalfWidthMs <= o.hatchThresholdMs
        ? 'fair'
        : 'poor';

  return {
    offset: estimate.offset,
    ciHalfWidthMs,
    ciLowMs: estimate.offset - ciHalfWidthMs,
    ciHighMs: estimate.offset + ciHalfWidthMs,
    confidence,
    hatched: ciHalfWidthMs > o.hatchThresholdMs,
    method: estimate.method,
    sampleCount: estimate.sampleCount,
  };
}
