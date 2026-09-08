// Proves two claims the multi-peer timeline depends on:
//   1. Hybrid Logical Clocks preserve causal order even when wall clocks lie.
//   2. NTP-style offset estimation converges under skew + asymmetric jitter.
// Exits non-zero on failure so CI can gate on it.
//
// REPOINTED: the HLC and the offset math now come from the extracted source
// module clock (imported directly — Node 24 strips TS types).
// The 8 original assertions are preserved verbatim; the module is the code under
// test. Deeper offset/skew + adversarial coverage lives in clock-skew.test.mjs.

import {
  HybridLogicalClock,
  compareHlc,
  offsetFromTimestamps,
  median,
} from '../clock/index.ts';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name} ${detail}`); failures++; }
}

// ---------- Hybrid Logical Clock (module under test) ----------
const cmp = compareHlc;

// Scenario: B's wall clock is 8 seconds BEHIND A's. A sends, B receives, B replies.
// Naive wall-clock ordering puts B's events before A's — HLC must not.
let tA = 1_000_000, tB = 1_000_000 - 8000;
const A = new HybridLogicalClock('A', () => tA);
const B = new HybridLogicalClock('B', () => tB);

const req      = A.send();        tA += 40; tB += 40;
const recvReq  = B.recv(req);     tB += 5;  tA += 5;
const res      = B.send();        tB += 40; tA += 40;
const recvRes  = A.recv(res);

check('HLC: request precedes its receipt',  cmp(req, recvReq) < 0,      `${JSON.stringify(req)} vs ${JSON.stringify(recvReq)}`);
check('HLC: receipt precedes response',     cmp(recvReq, res) < 0);
check('HLC: response precedes its receipt', cmp(res, recvRes) < 0);
check('HLC: full chain is totally ordered',
  [req, recvReq, res, recvRes].every((e, i, arr) => i === 0 || cmp(arr[i-1], e) < 0));

// Control: naive wall clock DOES invert, which is the bug HLC prevents.
const naive = [
  { n: 'A.send',  t: 1_000_000 },
  { n: 'B.recv',  t: 1_000_000 - 8000 + 40 },
];
check('CONTROL: raw wall clock inverts causality (proves the problem is real)',
  naive[1].t < naive[0].t, `B.recv t=${naive[1].t} < A.send t=${naive[0].t}`);

// ---------- Offset estimation (module math under test) ----------
function estimateOffset(trueOffset, samples, jitterMs, asymmetry = 0.5, seed = 42) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const est = [];
  for (let i = 0; i < samples; i++) {
    const rtt = 20 + rnd() * jitterMs;
    const out = rtt * asymmetry;           // outbound leg
    const back = rtt * (1 - asymmetry);    // return leg
    const t0 = 100000 + i * 1000;
    const t1 = t0 + out + trueOffset;      // remote receive (remote clock)
    const t2 = t1 + 1;                     // remote send
    const t3 = t2 - trueOffset + back;     // local receive (local clock)
    // offset/rtt computed by the extracted module, not inline.
    est.push(offsetFromTimestamps(t0, t1, t2, t3));
  }
  return est;
}

const TRUE = -8000;

// Symmetric paths: estimator should be near-exact.
const sym = estimateOffset(TRUE, 8, 60, 0.5);
const symMedian = median(sym.map(e => e.offset));
check('Offset: symmetric path, median within 2ms of truth',
  Math.abs(symMedian - TRUE) < 2, `got ${symMedian.toFixed(2)}, true ${TRUE}`);

// Single sample vs median-of-8 under jitter.
const jit = estimateOffset(TRUE, 8, 200, 0.5);
const singleErr = Math.abs(jit[0].offset - TRUE);
const medianErr = Math.abs(median(jit.map(e => e.offset)) - TRUE);
check('Offset: median-of-8 beats a single sample under jitter',
  medianErr <= singleErr, `single ${singleErr.toFixed(2)}ms vs median ${medianErr.toFixed(2)}ms`);

// Asymmetric routing (relay on the return path only) — the known failure mode.
const asym = estimateOffset(TRUE, 8, 60, 0.15);
const asymErr = Math.abs(median(asym.map(e => e.offset)) - TRUE);
check('Offset: asymmetric path introduces BOUNDED error, not unbounded',
  asymErr < 60, `error ${asymErr.toFixed(2)}ms`);
console.log(`        note: asymmetric-path error measured at ${asymErr.toFixed(1)}ms — this is a floor, not a bug`);

// Lowest-RTT sample as an alternative estimator.
const byLowRtt = [...asym].sort((a, b) => a.rtt - b.rtt)[0].offset;
console.log(`        lowest-RTT estimator error: ${Math.abs(byLowRtt - TRUE).toFixed(1)}ms`);

console.log(failures === 0 ? '\nAll clock claims verified.' : `\n${failures} claim(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
