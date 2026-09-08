// Proves the L2 collector claims against the SHIPPED source module
// (core). This test used to carry its implementation inline;
// the logic now lives in hrpc-inspector-probe and this suite exercises the real exports so
// the assertions guard what other layers actually import.
//
//   1. Memory is bounded under unbounded input (no leak) — ring buffer + bounded
//      pending map + bounded settled set.
//   2. Unanswered requests surface as timeouts rather than vanishing.
//   3. Fan-out (1 request -> N peers -> M responses) is representable.
//   4. Late responses after timeout don't resurrect or double-count.
//   5. NEW: tail sampling retains error traces head sampling would drop, WITH a
//      control proving tail sampling is load-bearing (disable it and the same
//      error trace is dropped by head sampling).
//   6. NEW: batched flush ships one batch under a burst, WITH a control proving
//      `add` alone never sends (per-event send would saturate the bridge).
//
// Node 24 strips TS types, so this .mjs imports the .ts sources directly.

import { Collector, Sampler, BatchFlusher, CollectorSink } from '../core/index.ts';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name} ${detail}`); failures++; }
};

// --- 1. Bounded memory under 100k requests ---
const c1 = new Collector({ maxEvents: 1000, maxPending: 500, timeoutMs: 1000, maxSettled: 4096 });
let t = 0;
for (let i = 0; i < 100_000; i++) {
  t += 1;
  c1.request(`c${i}`, 'blocks.fetch', ['peerA'], t);
  if (i % 2 === 0) c1.response(`c${i}`, 'peerA', t + 5);   // half go unanswered
  if (i % 100 === 0) c1.sweep(t);
}
c1.sweep(t + 10_000);
check('Ring buffer holds at its cap under 100k requests',
  c1.events.length === 1000, `len=${c1.events.length}`);
check('Pending map fully drains — no leak',
  c1.pending.size === 0, `pending=${c1.pending.size}`);
check('Drops are counted, not silent', c1.dropped > 0, `dropped=${c1.dropped}`);
console.log(`        ${c1.dropped} events dropped, ${c1.timedOut} timed out — both observable`);

// NEW invariant guard: the recently-settled set is BOUNDED, not an unbounded Set.
// (The original inline implementation used an unbounded Set here — a one-entry-
//  per-request leak. This asserts the fix.)
check('Recently-settled set stays bounded — no unbounded-Set leak',
  c1.settledSize <= 4096, `settledSize=${c1.settledSize}`);

// --- 2. Timeouts surface ---
const c2 = new Collector({ timeoutMs: 5000 });
c2.request('x1', 'crdt.sync', ['peerB'], 0);
c2.sweep(6000);
const to = c2.events.find(e => e.kind === 'timeout');
check('Unanswered request becomes a timeout row', !!to && to.corrId === 'x1');
check('Timeout row names the unanswered peer',
  to?.unanswered?.[0] === 'peerB', JSON.stringify(to?.unanswered));

// --- 3. Fan-out with partial response ---
const c3 = new Collector({ timeoutMs: 5000 });
c3.request('f1', 'blocks.want', ['p1','p2','p3'], 0);
c3.response('f1', 'p1', 120);
c3.response('f1', 'p3', 340);
c3.sweep(6000);
const fanTimeout = c3.events.find(e => e.kind === 'timeout' && e.corrId === 'f1');
check('Fan-out: 2 of 3 answered, request still settles',
  !!fanTimeout && fanTimeout.partial === 2, JSON.stringify(fanTimeout));
check('Fan-out: the silent peer is identified',
  fanTimeout?.unanswered?.length === 1 && fanTimeout.unanswered[0] === 'p2',
  JSON.stringify(fanTimeout?.unanswered));

// --- 4. Late response after timeout ---
const c4 = new Collector({ timeoutMs: 1000 });
c4.request('l1', 'presence.ping', ['pz'], 0);
c4.sweep(2000);
const before = c4.events.length;
c4.response('l1', 'pz', 3000);
check('Late response does not resurrect a timed-out request',
  c4.events.length === before, `events grew to ${c4.events.length}`);
check('Late response is counted for diagnostics',
  c4.lateAfterTimeout === 1, `late=${c4.lateAfterTimeout}`);

// --- 5. NEW: tail sampling retains error traces; CONTROL proves it is load-bearing ---
// Pick a corrId head sampling drops at 1%, then show the error rescues it only
// when tail sampling is enabled.
const HEAD_RATE = 0.01;
const errTrace = { corrId: 'trace-error-42', hasError: true, maxLatencyMs: 12 };

const sTail = new Sampler({ headRate: HEAD_RATE, latencyThresholdMs: 800, tailSampling: true });
const sNoTail = new Sampler({ headRate: HEAD_RATE, latencyThresholdMs: 800, tailSampling: false });

// Guard the premise: this corrId must be one head sampling WOULD drop, else the
// test proves nothing. (Both samplers share the deterministic head hash.)
check('Sampling premise: error trace is NOT head-sampled at 1%',
  sTail.headKeep(errTrace.corrId) === false,
  `headKeep=${sTail.headKeep(errTrace.corrId)}`);

check('Tail sampling retains an error trace head sampling would drop',
  sTail.keep(errTrace) === true);

// CONTROL: same trace, tail sampling disabled -> dropped. Proves tail sampling is
// what saved it above, not a vacuous always-keep.
check('CONTROL: with tail sampling OFF the same error trace is dropped',
  sNoTail.keep(errTrace) === false,
  `keep=${sNoTail.keep(errTrace)}`);

// And a latency-threshold trace is tail-kept the same way (belt and suspenders).
const slowTrace = { corrId: 'trace-slow-7', hasError: false, maxLatencyMs: 5000 };
check('Tail sampling retains an over-threshold slow trace',
  sTail.headKeep(slowTrace.corrId) === false && sTail.keep(slowTrace) === true,
  `headKeep=${sTail.headKeep(slowTrace.corrId)} keep=${sTail.keep(slowTrace)}`);

// --- 6. NEW: batched flush under burst; CONTROL proves add() never sends ---
const shipped = [];
const flusher = new BatchFlusher({ intervalMs: 200, onFlush: (batch) => shipped.push(batch) });
for (let i = 0; i < 500; i++) flusher.add({ kind: 'req', corrId: `b${i}` });

// CONTROL: 500 adds must have produced ZERO sends. Per-event send (the bug this
// layer exists to prevent) would have produced 500 and saturated the bridge.
check('CONTROL: 500 add() calls send nothing (not per-event)',
  flusher.flushCount === 0 && shipped.length === 0,
  `flushCount=${flusher.flushCount} sends=${shipped.length}`);

const n = flusher.flushNow();  // simulate one timer tick
check('Batched flush ships one batch of 500 on a single tick',
  shipped.length === 1 && shipped[0].length === 500 && n === 500,
  `sends=${shipped.length} size=${shipped[0]?.length}`);

// --- 7. NEW: L1->L2 seam. CollectorSink implements probe-engineer's EventSink ---
// A completed request must settle (no timeout); a request whose response never
// arrives must surface as a timeout row naming the silent peer. CONTROL: the
// answered request must NOT appear as a timeout.
const sink = new CollectorSink({ timeoutMs: 1000 });
sink.emit({ type: 'request.start', corrId: 'sk-ok', method: 'blocks.fetch', peerId: 'peerX', t: 0 });
sink.emit({ type: 'request.end',   corrId: 'sk-ok', peerId: 'peerX', t: 40 });
sink.emit({ type: 'request.start', corrId: 'sk-lost', method: 'crdt.sync', peerId: 'peerY', t: 0 });
sink.sweep(2000);
const okTimeout   = sink.collector.events.find(e => e.kind === 'timeout' && e.corrId === 'sk-ok');
const lostTimeout = sink.collector.events.find(e => e.kind === 'timeout' && e.corrId === 'sk-lost');
check('Sink: answered request settles (CONTROL: no timeout row)',
  !okTimeout, JSON.stringify(okTimeout));
check('Sink: unanswered request surfaces as a timeout naming the silent peer',
  !!lostTimeout && lostTimeout.unanswered?.[0] === 'peerY',
  JSON.stringify(lostTimeout?.unanswered));

// --- 8. NEW: constructor guards are load-bearing (Wave B gate findings) ---
// The 100-250ms flush window and the [0,1] headRate range are asserted in prose
// ("verified window", "spec range"); prove the guards actually reject out-of-range
// input so the words are backed by a test, not just a comment.
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

check('Flush: interval below the 100-250ms window is REJECTED',
  throws(() => new BatchFlusher({ intervalMs: 50, onFlush: () => {} })), 'intervalMs=50 should throw');
check('Flush: interval above the 100-250ms window is REJECTED',
  throws(() => new BatchFlusher({ intervalMs: 1000, onFlush: () => {} })), 'intervalMs=1000 should throw');
check('Flush CONTROL: an in-window interval (200ms) is ACCEPTED (guard is not always-throw)',
  !throws(() => new BatchFlusher({ intervalMs: 200, onFlush: () => {} })), '200ms should not throw');
check('Sampler: headRate outside [0,1] is REJECTED',
  throws(() => new Sampler({ headRate: 5 })), 'headRate=5 should throw');
check('Sampler CONTROL: a headRate in [0,1] (0.03) is ACCEPTED (guard is not always-throw)',
  !throws(() => new Sampler({ headRate: 0.03 })), 'headRate=0.03 should not throw');

// --- Memory sanity in real bytes ---
const heap = process.memoryUsage().heapUsed / 1024 / 1024;
console.log(`        heap after 100k requests: ${heap.toFixed(1)} MB`);
check('Heap stays under 100MB after 100k requests', heap < 100, `${heap.toFixed(1)}MB`);

console.log(failures === 0 ? '\nAll collector claims verified.' : `\n${failures} claim(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
