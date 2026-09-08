// G4(A) — VERIFIABLE HERE: the multi-peer MERGE logic.
//
// G4 proper (two devices on two independently-administered networks) is
// IMPOSSIBLE in this sandbox: one NAT'd interface, no DHT (C14/G4). See
// a real two-device field test for the residual human gate. What IS verifiable
// here is the piece the field test would exercise LAST: given frames arriving
// from >1 peer, does the hub reassemble them and merge them into ONE honest
// timeline?
//
// Setup (no real Hyperswarm, no network):
//   peer A ─ createHyperswarmExporter ─▶ in-mem writable ─▶ StreamFramer ┐
//                                                                         ├─▶ ONE merger
//   peer B ─ createHyperswarmExporter ─▶ in-mem writable ─▶ StreamFramer ┘
//
// Each peer has its OWN 1:1 stream to the hub (that is how Hyperswarm delivers
// a per-connection NoiseSecretStream), so the hub runs one StreamFramer per
// peer connection and folds every recovered event into a single merged list.
//
// Claims under test:
//   1. HLC merge orders a cross-peer causal chain correctly under an 8s
//      wall-clock skew between A and B (message leaves A, received at B).
//   2. CONTROL: merging the SAME events by raw wall clock INVERTS causality
//      (B's receipt sorts before A's send). Proves HLC is load-bearing.
//   3. Adversarial: B's wall clock STEPS BACKWARD mid-session (NTP correction);
//      HLC ordering survives, raw wall clock corrupts further.
//   4. Lanes stay distinguishable and raw `ts` is never overwritten.
//
// Imports the shipped source read-only (Node 24 strips TS types on import).
// NOT wired into run-all.sh (per task): run with `node verification/multipeer-merge.test.mjs`.

import { HybridLogicalClock, compareHlc, serializeHlc } from '../clock/index.ts';
import { createHyperswarmExporter } from '../exporters/hyperswarm.ts';
import { StreamFramer } from '../transport/framing.ts';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

console.log('multipeer-merge.test.mjs — two peers -> one merged timeline\n');

// ─────────────────────────────────────────────────────────────────────────
// In-memory duplex: a writable whose bytes flow straight into a hub-side
// StreamFramer, fed at ADVERSARIAL 3-byte boundaries so we also prove frames
// that straddle chunk/length-prefix edges still reassemble (transport-framing
// invariant, exercised across the peer boundary this time).
// ─────────────────────────────────────────────────────────────────────────
function makeLink(onEvent) {
  const framer = new StreamFramer((msg) => onEvent(JSON.parse(new TextDecoder().decode(msg))));
  const writable = {
    write(bytes) {
      for (let i = 0; i < bytes.length; i += 3) framer.push(bytes.subarray(i, Math.min(i + 3, bytes.length)));
      return true;
    },
  };
  return { writable, framer };
}

// The ONE hub-side merger. Every event from every peer lands in `merged`.
// Ordering by HLC is the product; ordering by raw ts is the control.
function makeMerger() {
  const merged = [];
  return {
    lane(peerId) {
      const { writable, framer } = makeLink((ev) => merged.push(ev));
      return { peerId, writable, framer };
    },
    byHlc: () => [...merged].sort((a, b) => compareHlc(a.hlc, b.hlc)),
    byRawWallClock: () => [...merged].sort((a, b) => a.ts - b.ts),
    all: () => merged,
  };
}

// A peer: an HLC + an independent (lie-able) wall clock, emitting L2 events
// through its exporter. We KEEP raw `ts` (wall clock) AND `hlc` side by side —
// never overwriting raw (Invariant 2).
const peers = [];
function makePeer(id, merger, initialWall) {
  let wall = initialWall;
  const hlc = new HybridLogicalClock(id, () => wall);
  const lane = merger.lane(id);
  const exporter = createHyperswarmExporter(lane.writable);
  peers.push(lane);
  const emit = (h, type, corrId) => {
    exporter.export([{ peer: id, type, corrId, ts: wall, hlc: serializeHlc(h) }]);
  };
  return {
    id,
    setWall: (t) => { wall = t; },
    advance: (ms) => { wall += ms; },
    send: (type, corrId) => { const h = hlc.send(); emit(h, type, corrId); return h; },
    recv: (type, corrId, remoteHlc) => { const h = hlc.recv(remoteHlc); emit(h, type, corrId); return h; },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Scenario: B's wall clock is 8s BEHIND A (the C6 skew). Causal chain across
// peers: A sends a request; B receives it; B replies; A receives the reply.
// ─────────────────────────────────────────────────────────────────────────
const merger = makeMerger();
const A = makePeer('A', merger, 1_000_000);
const B = makePeer('B', merger, 1_000_000 - 8000); // 8s behind

const hReq     = A.send('request.start', 'c1');           A.advance(40); B.advance(40);
const hRecvReq = B.recv('message.in',   'c1', hReq);      B.advance(5);  A.advance(5);
const hRes     = B.send('response.end', 'c1');            B.advance(40); A.advance(40);
const hRecvRes = A.recv('message.in',   'c1', hRes);

// Every event must have crossed the exporter -> writable -> framer path.
check('(1) merger reassembled all 4 cross-peer events', merger.all().length === 4,
  `${merger.all().length}/4`);
const pendingTotal = peers.reduce((n, l) => n + l.framer.pending, 0);
check('(2) no partial frame left buffered on either lane', pendingTotal === 0,
  `pending=${pendingTotal}`);

const hlcOrder = merger.byHlc();
const label = (e) => `${e.peer}:${e.type}`;
console.log('\n  merged timeline BY HLC (this run):');
for (const e of hlcOrder) console.log(`    ${e.hlc.padEnd(18)} ${label(e)}  (raw ts=${e.ts})`);

// The load-bearing cross-peer causal edge: A's send must precede B's receipt.
const iSend = hlcOrder.findIndex((e) => e.peer === 'A' && e.type === 'request.start');
const iRecv = hlcOrder.findIndex((e) => e.peer === 'B' && e.type === 'message.in');
check('(3) HLC merge: A.request precedes B.receipt across peers under 8s skew',
  iSend < iRecv, `A.send @${iSend}, B.recv @${iRecv}`);

// Full causal chain preserved as emitted.
const expected = ['A:request.start', 'B:message.in', 'B:response.end', 'A:message.in'];
check('(4) HLC merge preserves the full causal chain',
  JSON.stringify(hlcOrder.map(label)) === JSON.stringify(expected),
  hlcOrder.map(label).join(' -> '));

// Merged order is strictly increasing by HLC (a total order — no ties collapse).
check('(5) merged timeline is strictly totally ordered by HLC',
  hlcOrder.every((e, i) => i === 0 || compareHlc(hlcOrder[i - 1].hlc, e.hlc) < 0));

// Lanes distinguishable, raw ts intact (never overwritten).
const lanes = new Set(merger.all().map((e) => e.peer));
check('(6) each peer lane is distinguishable in the merged stream',
  lanes.size === 2 && lanes.has('A') && lanes.has('B'), `lanes={${[...lanes].join(',')}}`);
check('(7) raw wall-clock ts preserved alongside HLC (never overwritten)',
  merger.all().every((e) => typeof e.ts === 'number' && typeof e.hlc === 'string'));

// ─────────────────────────────────────────────────────────────────────────
// CONTROL: same events, merged by RAW WALL CLOCK. B is 8s behind, so B's
// receipt timestamp is < A's send timestamp -> the merged timeline shows the
// response's receipt BEFORE the request that caused it. This is the lie HLC
// removes; proving it is real is half the work.
// ─────────────────────────────────────────────────────────────────────────
const rawOrder = merger.byRawWallClock();
console.log('\n  CONTROL — merged timeline BY RAW WALL CLOCK (this run):');
for (const e of rawOrder) console.log(`    ts=${String(e.ts).padEnd(10)} ${label(e)}`);
const rawSend = rawOrder.findIndex((e) => e.peer === 'A' && e.type === 'request.start');
const rawRecv = rawOrder.findIndex((e) => e.peer === 'B' && e.type === 'message.in');
check('(8) CONTROL: raw wall-clock merge INVERTS causality (B.receipt sorts before A.send)',
  rawRecv < rawSend, `B.recv @${rawRecv} before A.send @${rawSend}`);
check('(9) CONTROL: raw wall-clock chain does NOT match causal order (proves HLC is load-bearing)',
  JSON.stringify(rawOrder.map(label)) !== JSON.stringify(expected),
  rawOrder.map(label).join(' -> '));

// ─────────────────────────────────────────────────────────────────────────
// ADVERSARIAL: B's RTC steps BACKWARD 3s mid-session (an NTP correction lands
// between B receiving and B replying). HLC's physical component is a monotonic
// ceiling, so ordering must still hold; the raw wall clock only gets worse.
// ─────────────────────────────────────────────────────────────────────────
const m2 = makeMerger();
const A2 = makePeer('A', m2, 2_000_000);
const B2 = makePeer('B', m2, 2_000_000 - 8000);
const g1 = A2.send('request.start', 'c9');            A2.advance(40); B2.advance(40);
const g2 = B2.recv('message.in',    'c9', g1);
B2.advance(-3000); // NTP step BACKWARD on B, after receiving, before replying
const g3 = B2.send('response.end',  'c9');            B2.advance(40); A2.advance(40);
const g4 = A2.recv('message.in',    'c9', g3);

const advHlc = m2.byHlc().map(label);
check('(10) ADVERSARIAL: HLC survives a backward RTC step mid-session',
  JSON.stringify(advHlc) === JSON.stringify(expected), advHlc.join(' -> '));
// Prove the step actually made the raw clock worse (control for the adversarial case).
const bRecvTs = m2.all().find((e) => e.peer === 'B' && e.type === 'message.in').ts;
const bSendTs = m2.all().find((e) => e.peer === 'B' && e.type === 'response.end').ts;
check('(11) ADVERSARIAL CONTROL: backward step makes B.send raw ts EARLIER than B.recv raw ts',
  bSendTs < bRecvTs, `B.recv ts=${bRecvTs}, B.send ts=${bSendTs}`);

console.log(failures === 0 ? '\nAll multipeer-merge claims verified.' : `\n${failures} claim(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
