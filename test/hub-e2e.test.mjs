// End-to-end wire-contract test: app-side exporter -> (bytes) -> hub-side reader.
//
// Proves the missing "attach mobile app to hub" brick works WITHOUT a device or network:
// the Hyperswarm exporter's framed output, fed at arbitrary chunk boundaries into the same
// StreamFramer the hub uses, reassembles into the exact L2 events the collector emitted.
//
// This is the app<->hub contract from the architecture diagram. Two peers connecting over a
// real network is UNVERIFIABLE HERE (one NAT'd interface, C14/G4); the wire contract is not.

import { createHyperswarmExporter } from '../exporters/hyperswarm.ts';
import { StreamFramer } from '../transport/framing.ts';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('hub-e2e.test.mjs — exporter -> hub reader wire contract\n');

// A realistic flushed batch of L2 events (what BatchFlusher hands the exporter).
const batch = [
  { type: 'request.start', corrId: 'c1', method: 'blocks.fetch', peerId: 'peerA', bytes: 90, t: 0 },
  { type: 'request.end', corrId: 'c1', peerId: 'peerA', bytes: 512, t: 42 },
  { type: 'message.out', corrId: 'c2', method: 'presence.ping', peerId: 'peerB', bytes: 90, t: 50 },
  { type: 'timeout', corrId: 'c3', method: 'crdt.sync', unanswered: ['peerC'], t: 1200 },
];

// --- App side: exporter writes framed bytes into the (fake) hub connection. ---
let wire = new Uint8Array(0);
const fakeStream = {
  write(bytes) {
    const next = new Uint8Array(wire.length + bytes.length);
    next.set(wire, 0);
    next.set(bytes, wire.length);
    wire = next;
    return true;
  },
};
const exporter = createHyperswarmExporter(fakeStream);
exporter.export(batch);
check('(a) exporter produced framed bytes on the wire', wire.length > 0, `${wire.length} B for ${batch.length} events`);

// --- Hub side: reassemble with the SAME StreamFramer, fed at ADVERSARIAL boundaries. ---
const received = [];
const framer = new StreamFramer((msg) => received.push(JSON.parse(new TextDecoder().decode(msg))));
// Split into tiny 3-byte chunks so many frames are split mid-length-prefix and mid-payload.
for (let i = 0; i < wire.length; i += 3) framer.push(wire.subarray(i, Math.min(i + 3, wire.length)));

check('(b) hub recovered every event, in order', eq(received, batch), `${received.length}/${batch.length}`);
check('(c) no partial frame left buffered', framer.pending === 0, `pending=${framer.pending}`);

// --- CONTROL: a naive "one data chunk = one message" reader corrupts the stream. ---
// (This is what you'd write if you forgot framing — the bug the framer prevents.)
const naive = [];
for (let i = 0; i < wire.length; i += 3) {
  try { naive.push(JSON.parse(new TextDecoder().decode(wire.subarray(i, Math.min(i + 3, wire.length))))); }
  catch { /* most 3-byte slices are not valid JSON */ }
}
check('(d) CONTROL: naive per-chunk decode does NOT recover the batch (framing is load-bearing)',
  !eq(naive, batch), `naive recovered ${naive.length} vs ${batch.length}`);

// --- CONTROL: exporter never throws into the app even if the stream write fails. ---
let threw = false;
const throwingStream = { write() { throw new Error('stream closed'); } };
const errs = [];
const safeExporter = createHyperswarmExporter(throwingStream, { onError: (e) => errs.push(e) });
try { safeExporter.export(batch); } catch { threw = true; }
check('(e) exporter swallows write errors (monitor never crashes the transport)', !threw && errs.length === batch.length,
  `threw=${threw} errors-captured=${errs.length}`);

console.log(failures === 0 ? '\nAll hub-e2e claims verified.' : `\n${failures} claim(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
