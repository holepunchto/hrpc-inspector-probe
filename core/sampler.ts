// L2 sampling. Two independent gates, ANDed as an OR of "keep" reasons:
//
//   HEAD sampling: keep a small, deterministic fraction (1-5%) of ALL traces so
//   the baseline waterfall stays representative without shipping every gossip
//   message. Deterministic in the corrId so that every row of one trace (req,
//   res, timeout) shares one keep/drop verdict — you never keep a response whose
//   request was dropped.
//
//   TAIL sampling: keep 100% of traces that carry an error OR exceed a latency
//   threshold, regardless of the head verdict. This is the load-bearing gate:
//   the interesting traces are exactly the rare ones head sampling would throw
//   away. `correlator.test.mjs` proves this with a control — with tail sampling
//   disabled the same error trace is dropped by head sampling.

export interface SamplerOptions {
  /** Head keep-rate in [0,1]. Spec range 0.01-0.05 (1-5%). */
  headRate: number;
  /** A trace whose observed latency exceeds this (same clock domain as rows) is tail-kept. */
  latencyThresholdMs?: number;
  /** Master switch for the tail gate. Off = head sampling only (the control case). */
  tailSampling?: boolean;
}

/** Minimal per-trace summary the sampler needs to decide. */
export interface TraceSummary {
  corrId: string;
  /** True if any row in the trace is an error / timeout. */
  hasError?: boolean;
  /** Largest observed latency across the trace's responses, if any. */
  maxLatencyMs?: number;
}

/** FNV-1a 32-bit hash -> [0,1). Cheap, stable, no dependency. */
function hashUnit(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 -> unsigned; divide by 2^32 for a stable fraction in [0,1).
  return (h >>> 0) / 0x100000000;
}

export class Sampler {
  readonly headRate: number;
  readonly latencyThresholdMs: number;
  readonly tailSampling: boolean;

  constructor({ headRate, latencyThresholdMs = Infinity, tailSampling = true }: SamplerOptions) {
    if (!(headRate >= 0 && headRate <= 1)) {
      throw new RangeError(`headRate must be in [0,1], got ${headRate}`);
    }
    this.headRate = headRate;
    this.latencyThresholdMs = latencyThresholdMs;
    this.tailSampling = tailSampling;
  }

  /** Deterministic head verdict for a corrId. Same corrId -> same answer, always. */
  headKeep(corrId: string): boolean {
    return hashUnit(corrId) < this.headRate;
  }

  /** Would the tail gate rescue this trace? False if tail sampling is disabled. */
  tailKeep(trace: TraceSummary): boolean {
    if (!this.tailSampling) return false;
    if (trace.hasError) return true;
    if ((trace.maxLatencyMs ?? -Infinity) > this.latencyThresholdMs) return true;
    return false;
  }

  /** Final verdict: keep if head OR tail says keep. */
  keep(trace: TraceSummary): boolean {
    return this.headKeep(trace.corrId) || this.tailKeep(trace);
  }
}
