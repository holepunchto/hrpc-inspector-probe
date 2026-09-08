// hrpc-inspector-probe/clock — clock-correctness module for the multi-peer timeline.
//
// Three concerns, three invariants:
//   hlc.ts    — HLC wins for ORDERING (corrected wall clock is spacing only).
//   offset.ts — per-peer offset; raw `ts` and derived `tsNormalized` kept side
//               by side, raw NEVER overwritten. Primary estimator lowest-RTT,
//               median fallback when RTT variance is low (finding C8).
//   skew.ts   — per-peer confidence interval; the UI hatches a lane when poor.
//
// Integrates with hrpc-inspector-protocol: HLC serializes to the frozen P2PEnvelope.hlc
// "phys:ctr:node" wire form, and PeerOffsetEstimator is keyed by PeerId.

export type { HlcTime, ClockFn } from './hlc.ts';
export {
  HybridLogicalClock,
  serializeHlc,
  parseHlc,
  compareHlc,
} from './hlc.ts';

export type {
  RttSample,
  OffsetMethod,
  OffsetEstimate,
  NormalizedTs,
  EstimatorOptions,
} from './offset.ts';
export {
  PeerOffsetEstimator,
  offsetFromTimestamps,
  median,
  stddev,
} from './offset.ts';

export type { Confidence, SkewConfidence, SkewOptions } from './skew.ts';
export { skewConfidence } from './skew.ts';
