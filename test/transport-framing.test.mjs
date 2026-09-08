// Proves the transport generalization layer (transport/,
// adapters/hyperswarm.ts) holds its contract:
//
//   (a) StreamFramer round-trip: N envelopes, arbitrary chunk boundaries
//       (mid-frame split AND two-frames-in-one-chunk), reassembles to
//       exactly N whole messages, in order.
//       CONTROL: the SAME arbitrarily-chunked byte stream, fed WITHOUT the
//       framer (naive "one chunk == one message"), produces corrupted/
//       misaligned output — proves framing is load-bearing, not vacuous.
//   (b) instrumentHyperswarmStream against a FAKE NoiseSecretStream is a
//       PASSTHROUGH TAP IN BOTH DIRECTIONS: an app-level round trip through an
//       instrumented writer to an UNinstrumented reader delivers byte-identical
//       payloads, events are still emitted for both directions, and the write
//       tap still reports bytes + bufferedAmount-analog + return value +
//       identity from remotePublicKey.
//       CONTROLS: (i) framing the app payload — the defect this section used to
//       assert as DESIRED — would corrupt an unprobed receiver; (ii) the
//       observability EXPORTER channel DOES still frame, so framing is scoped,
//       not deleted; (iii) disabled = genuine no-op (same as WebRTC/WS).
//   (c) capabilitiesAllowIdentityDrop + hrpc-inspector-protocol's checkIdentityDrop:
//       both permit drop for the 1:1 hyperswarm stream and refuse it for a
//       multiplexed descriptor — proving L0 needed ZERO changes to support
//       the new transport.
//   (d) shared adapter contract: all three TRANSPORT_REGISTRY entries expose
//       the identical {name, capabilities, instrument()} shape, and disabling
//       each is a verified no-op — one seam, three transports.
//
// UNVERIFIABLE HERE: `pear`/`bare` are installed (bare v1.28.0, measured this
// session), but there is no live Hyperswarm connection, no second peer, and
// no independent network topology available (one NAT'd interface
// here). The FAKE duplex stream below mirrors NoiseSecretStream's documented
// method shape; this file verifies the WRAPPER + FRAMING logic only, not
// real on-device Hyperswarm/UDX behaviour.

import { StreamFramer, encodeFrame, createFramer } from '../transport/framing.ts';
import { capabilitiesAllowIdentityDrop, HYPERSWARM_CAPABILITIES } from '../transport/capabilities.ts';
import { instrumentHyperswarmStream, publicKeyToPeerId } from '../adapters/hyperswarm.ts';
import { createHyperswarmExporter } from '../exporters/hyperswarm.ts';
import { TRANSPORT_REGISTRY } from '../transport/contract.ts';
import { checkIdentityDrop } from 'hrpc-inspector-protocol/identity';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS  ' + m)) : (fail++, console.log('  FAIL  ' + m)); };

console.log('transport-framing.test.mjs — Hyperswarm adapter + transport generalization\n');

// ---------------------------------------------------------------------------
// (a) StreamFramer round-trip under arbitrary chunk boundaries + CONTROL
// ---------------------------------------------------------------------------
console.log('(a) StreamFramer — arbitrary chunk boundaries reassemble exactly N messages, in order:\n');
{
  const messages = [
    'short',
    JSON.stringify({ corrId: 'c1', msgId: 'm1', method: 'blocks.fetch', kind: 'req' }),
    'x'.repeat(500), // long enough to itself span multiple small chunks
    '',
    JSON.stringify({ corrId: 'c2', kind: 'res', payload: { blocks: [1, 2, 3] } }),
  ];
  const N = messages.length;

  const frames = messages.map((m) => encodeFrame(m));
  let full = new Uint8Array(0);
  for (const f of frames) {
    const merged = new Uint8Array(full.length + f.length);
    merged.set(full, 0);
    merged.set(f, full.length);
    full = merged;
  }

  // Arbitrary chunk boundaries: deliberately include a split that lands
  // INSIDE the 4-byte length prefix (chunk size 2), a split mid-payload
  // (chunk size 7), and large chunks that coalesce 2+ frames together.
  function chunkAt(buf, sizes) {
    const chunks = [];
    let i = 0, si = 0;
    while (i < buf.length) {
      const size = sizes[si % sizes.length];
      chunks.push(buf.slice(i, i + size));
      i += size;
      si++;
    }
    return chunks;
  }

  for (const sizes of [[2, 7, 1000], [3], [1], [1000], [5, 5, 5, 5, 5, 5, 5]]) {
    const received = [];
    const framer = new StreamFramer((bytes) => received.push(new TextDecoder().decode(bytes)));
    for (const chunk of chunkAt(full, sizes)) framer.push(chunk);

    ok(received.length === N, `chunk sizes ${JSON.stringify(sizes)}: exactly ${N} messages recovered (got ${received.length})`);
    ok(JSON.stringify(received) === JSON.stringify(messages), `chunk sizes ${JSON.stringify(sizes)}: content AND order match the originals exactly`);
    ok(framer.pending === 0, `chunk sizes ${JSON.stringify(sizes)}: zero bytes left pending after a complete stream`);
  }

  // Split EXACTLY inside the length prefix (after 2 of its 4 bytes) as an
  // explicit boundary case, not just covered incidentally by the loop above.
  {
    const received = [];
    const framer = new StreamFramer((bytes) => received.push(new TextDecoder().decode(bytes)));
    framer.push(full.slice(0, 2));   // half of the very first length prefix
    framer.push(full.slice(2, 3));   // rest of the length prefix, arriving alone
    framer.push(full.slice(3));      // everything else in one big chunk
    ok(JSON.stringify(received) === JSON.stringify(messages), 'length-prefix split byte-by-byte still reassembles correctly');
  }
}

// CONTROL: WITHOUT the framer, the same arbitrarily-chunked stream (raw,
// unframed application bytes, chunked at OS-like boundaries) does NOT
// recover the original messages when treated as "one chunk == one message" —
// proves the framer is doing real work, not vacuously passing because the
// test data happened to be small enough to always arrive whole.
console.log('\n(a) CONTROL — WITHOUT framing, the same split stream is corrupted/misaligned:\n');
{
  const messages = ['first-message', 'second-message', 'third-message'];
  const raw = messages.join(''); // no delimiters at all: what a naive concatenated write looks like on the wire
  const bytes = new TextEncoder().encode(raw);
  // Chunk at fixed 6-byte boundaries — guaranteed NOT to land on message boundaries.
  const naiveChunks = [];
  for (let i = 0; i < bytes.length; i += 6) naiveChunks.push(bytes.slice(i, i + 6));

  const naivelyDecoded = naiveChunks.map((c) => new TextDecoder().decode(c));
  ok(naivelyDecoded.length !== messages.length, `CONTROL: naive "one chunk == one message" yields ${naivelyDecoded.length} chunks, not the original ${messages.length} messages`);
  ok(JSON.stringify(naivelyDecoded) !== JSON.stringify(messages), 'CONTROL: naive chunk contents do NOT match the original messages (proves reassembly is necessary, not optional)');
}

// ---------------------------------------------------------------------------
// (b) instrumentHyperswarmStream against a fake NoiseSecretStream duplex
//     ADJUDICATED CONTRACT: the app-data tap OBSERVES ONLY. It must never
//     alter, consume or reframe the application's bytes in either direction.
// ---------------------------------------------------------------------------
console.log('\n(b) instrumentHyperswarmStream — PASSTHROUGH tap: app bytes unaltered in BOTH directions:\n');

class MemorySink {
  constructor() { this.events = []; }
  emit(e) { this.events.push(e); }
}

// Mirrors the real API surface: .write(buf), .on('data'|'close', cb),
// .remotePublicKey, .writableLength (Node/Bare Writable backpressure analog).
class FakeNoiseSecretStream {
  constructor(remotePublicKey) {
    this.remotePublicKey = remotePublicKey;
    this.writableLength = 0;
    this._listeners = new Map();
    this.writeCalls = [];
    this._writeImpl = (data) => { this.writeCalls.push(data); return true; };
  }
  write(data) { return this._writeImpl(data); }
  on(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeListener(type, fn) {
    const arr = this._listeners.get(type) || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  emitData(chunk) { for (const fn of this._listeners.get('data') || []) fn(chunk); }
  emitClose() { for (const fn of this._listeners.get('close') || []) fn(); }
}

const asBytes = (d) => (typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d));
const cat = (chunks) => {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
};
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const hex = (u8) => Array.from(u8, (x) => x.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------------------
// (b1) APP-LEVEL ROUND TRIP: instrumented writer -> UNinstrumented reader.
// The remote peer is NOT required to run this probe (the adapter is exported
// per-side: hrpc-inspector/src/index.ts), so whatever the instrumented
// side writes must be exactly what an unprobed peer's application reads.
// ---------------------------------------------------------------------------
{
  const writerSink = new MemorySink();
  const readerSink = new MemorySink();

  const writer = new FakeNoiseSecretStream(new Uint8Array([0xaa, 0xbb]));
  instrumentHyperswarmStream(writer, writerSink);

  // The reader end is a SEPARATE stream with NO instrumentation at all — it
  // stands in for the peer application that never heard of this probe.
  const readerReceived = [];
  const reader = new FakeNoiseSecretStream(new Uint8Array([0xcc, 0xdd]));
  reader.on('data', (chunk) => readerReceived.push(asBytes(chunk)));

  const appPayloads = [
    JSON.stringify({ corrId: 'a1', msgId: 'am1', method: 'blocks.fetch', kind: 'req' }),
    'plain-string-payload',
    '',
    // Raw binary whose FIRST FOUR BYTES look exactly like a big length prefix:
    // the precise input a length-prefix framer on this path would misparse.
    new Uint8Array([0x00, 0x01, 0x86, 0xa0, 0x11, 0x22, 0x33]),
    new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x01]),
  ];

  for (const p of appPayloads) writer.write(p);
  // The "wire": deliver, in order, exactly the bytes origWrite received.
  for (const w of writer.writeCalls) reader.emitData(w);

  const expected = cat(appPayloads.map(asBytes));
  const actual = cat(readerReceived);
  ok(sameBytes(actual, expected),
    `app-level round trip: an UNinstrumented reader receives BYTE-IDENTICAL bytes to what the app wrote (${expected.length} B)`);
  ok(actual.length === expected.length,
    `app-level round trip: zero bytes added or removed on the app stream (got ${actual.length}, wrote ${expected.length})`);
  ok(writer.writeCalls.length === appPayloads.length,
    `origWrite called exactly once per app write (${writer.writeCalls.length}/${appPayloads.length})`);
  ok(writer.writeCalls.every((w, i) => sameBytes(asBytes(w), asBytes(appPayloads[i]))),
    'each origWrite argument equals the app payload for that call, chunk for chunk (no re-batching)');
  ok(writer.writeCalls[1] === appPayloads[1],
    'a string payload is handed to origWrite as the IDENTICAL value (not re-encoded to bytes by the tap)');
  ok(writer.writeCalls[3] === appPayloads[3],
    'a Uint8Array payload is handed to origWrite as the IDENTICAL reference (no copy, no prefix)');

  // (b) events are still emitted for BOTH directions.
  ok(writerSink.events.length === appPayloads.length,
    `outbound: one event per write, observation intact while passing through (${writerSink.events.length})`);
  ok(writerSink.events[0]?.type === 'request.start' && writerSink.events[0]?.corrId === 'a1',
    "outbound: kind:'req' -> 'request.start' with corrId decoded from the app payload");
  ok(writerSink.events.every((e) => e.transport === 'hyperswarm'), "outbound: transport tagged 'hyperswarm'");
  ok(readerSink.events.length === 0,
    'CONTROL: the UNinstrumented reader emits zero events (it really is unprobed — the round trip above is not self-confirming)');
}

// ---------------------------------------------------------------------------
// (b1) CONTROL — framing the app payload (the reverted defect) DOES corrupt
// the unprobed peer. Proves the byte-identity assertions above discriminate.
// ---------------------------------------------------------------------------
console.log('\n(b) CONTROL — the old behaviour (framing app data) would corrupt an unprobed peer:\n');
{
  const payload = JSON.stringify({ corrId: 'ctl', kind: 'req' });
  const framed = encodeFrame(payload);       // what the defect wrote
  const raw = asBytes(payload);              // what the app actually wrote

  ok(!sameBytes(framed, raw),
    `CONTROL: framed bytes differ from the app payload (${framed.length} B vs ${raw.length} B) — the receiver's application would see [len][payload]`);
  ok(framed.length === raw.length + 4 && hex(framed.slice(0, 4)) === raw.length.toString(16).padStart(8, '0'),
    'CONTROL: the difference is exactly a 4-byte big-endian length prefix prepended to the app protocol');

  const writer = new FakeNoiseSecretStream(new Uint8Array([1]));
  instrumentHyperswarmStream(writer, new MemorySink());
  writer.write(payload);
  ok(writer.writeCalls.length === 1 && !sameBytes(asBytes(writer.writeCalls[0]), framed),
    'CONTROL: the CURRENT tap does NOT write the framed form (this check fails if the defect is reintroduced)');
  ok(writer.writeCalls.length === 1 && sameBytes(asBytes(writer.writeCalls[0]), raw),
    'CONTROL: the CURRENT tap writes the raw app payload instead');
}

// ---------------------------------------------------------------------------
// (b2) INBOUND is observe-only: one event per 'data' chunk, no framer, no
// buffering, bytes counted exactly, chunk never consumed or reframed.
// ---------------------------------------------------------------------------
console.log('\n(b) inbound tap — observes each chunk as it arrives, consumes nothing:\n');
{
  const stream = new FakeNoiseSecretStream(new Uint8Array([1, 2, 3]));
  const sink = new MemorySink();
  const appSeen = [];
  // An application 'data' listener registered ALONGSIDE the probe: it must
  // still see every byte, because the probe never consumes the chunk.
  stream.on('data', (c) => appSeen.push(asBytes(c)));
  instrumentHyperswarmStream(stream, sink, { peerId: 'explicit-peer' });

  const msg1 = JSON.stringify({ corrId: 'r1', kind: 'res', method: 'blocks.fetch' });
  const msg2 = JSON.stringify({ corrId: 'r2', kind: 'event' });
  const chunks = [asBytes(msg1), asBytes(msg2), new Uint8Array([0xff, 0x00, 0xfe])];
  for (const c of chunks) stream.emitData(c);

  ok(sink.events.length === 3, `three inbound chunks -> exactly 3 events, emitted as they arrive (got ${sink.events.length})`);
  ok(sink.events[0]?.type === 'request.end' && sink.events[0]?.corrId === 'r1',
     "inbound: kind:'res' -> 'request.end', corrId decoded from the RAW (unframed) chunk");
  ok(sink.events[1]?.type === 'message.in' && sink.events[1]?.corrId === 'r2',
     "inbound: kind:'event' -> 'message.in', second chunk observed in order");
  ok(sink.events[2]?.type === 'message.in' && sink.events[2]?.corrId === undefined,
     'inbound: undecodable binary chunk still produces an event, with no envelope hint invented');
  ok(sink.events.length === chunks.length && sink.events.every((e, i) => e.bytes === chunks[i].length),
     'inbound: bytes is the exact chunk length for every chunk (measured, not framed)');
  ok(sink.events.every((e) => e.transport === 'hyperswarm' && e.peerId === 'explicit-peer'),
     'inbound: explicit peerId override respected (not forced to intrinsic identity)');
  ok(appSeen.length === chunks.length && appSeen.every((c, i) => sameBytes(c, chunks[i])),
     'inbound: a co-registered application listener still sees every chunk byte-for-byte (probe consumes nothing)');

  // CONTROL: a length-prefix framer on this path swallows raw app bytes.
  // Feeding the SAME chunks through StreamFramer emits nothing at all — it
  // reads '{"co' as a ~1.7 GB length and buffers forever.
  let framedOut = 0;
  const wrongFramer = new StreamFramer(() => { framedOut++; });
  for (const c of chunks) wrongFramer.push(c);
  ok(framedOut === 0 && wrongFramer.pending === cat(chunks).length,
     `CONTROL: a StreamFramer over these same raw app chunks emits 0 events and buffers all ${wrongFramer.pending} bytes — proves the inbound framer had to go`);
  ok(sink.events.length === 3 && framedOut === 0,
     'CONTROL: the passthrough tap observed all 3 chunks where the framer observed none');
}

// Malformed / hostile inbound shapes must never throw into the app's stream.
{
  const stream = new FakeNoiseSecretStream(new Uint8Array([7]));
  const sink = new MemorySink();
  instrumentHyperswarmStream(stream, sink);
  let threw = false;
  try {
    stream.emitData(new Uint8Array([0xff, 0xfe, 0xfd])); // invalid UTF-8
    stream.emitData('a string chunk');
    stream.emitData(undefined);
    stream.emitData({ not: 'a chunk' });
  } catch { threw = true; }
  ok(!threw, 'inbound: invalid UTF-8, string, undefined and non-chunk inputs never throw out of the data tap');
}

// Outbound errors from the real transport must still reach the app unchanged.
{
  const stream = new FakeNoiseSecretStream(new Uint8Array([8]));
  const boom = new Error('udx: stream destroyed');
  stream._writeImpl = () => { throw boom; };
  const sink = new MemorySink();
  instrumentHyperswarmStream(stream, sink);
  let caught;
  try { stream.write('x'); } catch (e) { caught = e; }
  ok(caught === boom, 'outbound: a genuine transport error is rethrown to the app as the IDENTICAL error object');
  ok(sink.events.length === 1 && sink.events[0].type === 'send.error',
     'outbound: that failure is reported once as send.error (and only the app write lives inside the rethrowing try)');
}

// ---------------------------------------------------------------------------
// (b3) write-tap measurements survive the passthrough change.
// ---------------------------------------------------------------------------
console.log('\n(b) write tap — measurements + intrinsic identity:\n');
{
  const remoteKey = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
  const stream = new FakeNoiseSecretStream(remoteKey);
  stream.writableLength = 17; // the queue depth THIS write actually faced
  const sink = new MemorySink();
  instrumentHyperswarmStream(stream, sink);

  const payload = JSON.stringify({ corrId: 'h1', msgId: 'hm1', method: 'blocks.fetch', kind: 'req' });
  const ret = stream.write(payload);

  ok(ret === true, 'write() returns the ORIGINAL return value unchanged');
  ok(stream.writeCalls.length === 1, 'origWrite called exactly once');
  ok(stream.writeCalls[0] === payload,
     'origWrite received the app payload UNMODIFIED (identical value, no length prefix)');

  ok(sink.events.length === 1, 'exactly one event emitted for one write()');
  const e = sink.events[0] ?? {};
  ok(e.type === 'request.start', "kind:'req' -> type 'request.start' (identical vocabulary to the WebRTC adapter)");
  ok(e.bufferedAmount === 17, `writableLength captured BEFORE write (=17) — measured ${e.bufferedAmount}`);
  ok(e.bytes === new TextEncoder().encode(payload).length, 'bytes measures the APPLICATION payload (which is now also the wire size)');
  ok(e.transport === 'hyperswarm', "transport tagged 'hyperswarm'");

  // Independently recompute the expected hex (not by calling publicKeyToPeerId
  // again) so this isn't a tautological check of the adapter's own helper.
  const expectedHex = Array.from(remoteKey).map((b) => b.toString(16).padStart(2, '0')).join('');
  ok(e.peerId === expectedHex, `peerId derived from remotePublicKey with NO explicit peerId passed (intrinsic identity) — got ${e.peerId}`);
  ok(e.peerId === 'deadbeef0102', 'concrete expected hex matches (deadbeef0102)');
}

// Close event
{
  const stream = new FakeNoiseSecretStream(new Uint8Array([9, 9]));
  const sink = new MemorySink();
  instrumentHyperswarmStream(stream, sink);
  stream.emitClose();
  ok(sink.events.some((e) => e.type === 'conn.state' && e.event === 'close'), 'stream close tapped as conn.state/close');
}

// ---------------------------------------------------------------------------
// (b4) framing is NOT deleted — it still governs the dedicated observability
// channel, where this probe owns BOTH ends (exporters/hyperswarm.ts -> the
// hub's FrameReader). This is the boundary the fix draws.
// ---------------------------------------------------------------------------
console.log('\n(b) exporter channel — length-prefix framing IS still applied where the probe owns both ends:\n');
{
  const written = [];
  const hubStream = { write(bytes) { written.push(bytes); return true; } };
  const exporter = createHyperswarmExporter(hubStream);

  const batch = [
    { type: 'request.start', corrId: 'e1', peerId: 'p1' },
    { type: 'request.end', corrId: 'e2', peerId: 'p1' },
  ];
  exporter.export(batch);

  ok(written.length === batch.length, `exporter wrote one frame per event (${written.length}/${batch.length})`);
  ok(written.every((w) => {
    const declared = new DataView(w.buffer, w.byteOffset, 4).getUint32(0, false);
    return declared === w.length - 4;
  }), 'exporter frames carry a 4-byte BE length prefix that matches the payload length exactly');

  // And the receiving end reassembles them with StreamFramer under hostile
  // chunking — the framer coverage in (a) applies to THIS channel.
  const wire = cat(written.map(asBytes));
  const decoded = [];
  const framer = new StreamFramer((m) => decoded.push(JSON.parse(new TextDecoder().decode(m))));
  for (let i = 0; i < wire.length; i += 3) framer.push(wire.slice(i, i + 3));
  ok(decoded.length === batch.length && JSON.stringify(decoded) === JSON.stringify(batch),
     'exporter channel: StreamFramer recovers the exact batch from a 3-byte-chunked stream (framing still load-bearing here)');
  ok(framer.pending === 0, 'exporter channel: nothing left pending after a complete stream');

  // CONTROL: the app tap and the exporter channel genuinely differ in behaviour.
  const tapStream = new FakeNoiseSecretStream(new Uint8Array([1]));
  instrumentHyperswarmStream(tapStream, new MemorySink());
  const sameEvent = JSON.stringify(batch[0]);
  tapStream.write(sameEvent);
  ok(tapStream.writeCalls.length === 1 && asBytes(tapStream.writeCalls[0]).length === asBytes(sameEvent).length
     && written[0].length === asBytes(sameEvent).length + 4,
     'CONTROL: identical bytes are UNFRAMED through the app tap and FRAMED through the exporter — the two channels are not the same code path');
}

// CONTROL: disabled = genuine no-op, same guarantee proven for webrtc/websocket.
console.log('\n(b) CONTROL — disabled Hyperswarm probe is a genuine no-op:\n');
{
  const stream = new FakeNoiseSecretStream(new Uint8Array([1, 2, 3]));
  const originalWriteRef = stream.write;
  const sink = new MemorySink();
  const inst = instrumentHyperswarmStream(stream, sink, { enabled: false });

  ok(stream.write === originalWriteRef, 'DISABLED: stream.write is left as the EXACT original reference');
  const ret = stream.write('payload-when-disabled');
  ok(ret === true && stream.writeCalls.length === 1 && stream.writeCalls[0] === 'payload-when-disabled',
     'DISABLED: origWrite called once, with the identical (UNFRAMED) arg, original return value preserved');
  stream.emitData(new Uint8Array([1, 2, 3]));
  stream.emitClose();
  ok(sink.events.length === 0, 'DISABLED: zero events emitted across write + data + close');
  inst.restore();
  ok(true, 'DISABLED: restore() on a no-op instrument does not throw');
}

// ---------------------------------------------------------------------------
// (c) capabilities-driven identity-drop
// ---------------------------------------------------------------------------
console.log('\n(c) capabilities-driven identity-drop — permits 1:1 hyperswarm, refuses multiplexed:\n');
{
  ok(capabilitiesAllowIdentityDrop({ capabilities: HYPERSWARM_CAPABILITIES, topology: 'unicast-1to1' }) === true,
     'capabilitiesAllowIdentityDrop: PERMITS drop on a 1:1 Hyperswarm stream');

  const multiplexedHyperswarmLike = { ...HYPERSWARM_CAPABILITIES, multiplexed: true };
  ok(capabilitiesAllowIdentityDrop({ capabilities: multiplexedHyperswarmLike, topology: 'unicast-1to1' }) === false,
     'capabilitiesAllowIdentityDrop: REFUSES drop when capabilities.multiplexed=true, even with topology unicast-1to1 (capability wins)');

  ok(capabilitiesAllowIdentityDrop({ capabilities: HYPERSWARM_CAPABILITIES, topology: 'fanout' }) === false,
     'capabilitiesAllowIdentityDrop: REFUSES drop on fanout topology regardless of capabilities');

  // Cross-check against hrpc-inspector-protocol's OWN guard (identity.ts), constructed
  // with transport:'hyperswarm' — a value NOT in identity.ts's frozen
  // `Transport` union. If this throws or misbehaves, L0 would need editing
  // to support the new transport; it does not, because checkIdentityDrop's
  // logic is topology/transport-carve-out structural, not an enum switch
  // over every known transport.
  const remoteKey = () => 'peer-from-noise-handshake';
  const oneToOneBinding = {
    topology: 'unicast-1to1',
    transport: 'hyperswarm',
    resolveSrc: remoteKey,
    resolveDst: () => 'me',
  };
  ok(checkIdentityDrop(oneToOneBinding).ok === true,
     "L0's checkIdentityDrop (UNMODIFIED) ACCEPTS drop for transport:'hyperswarm' on a 1:1 channel — zero L0 edits needed to add this transport");

  const multiplexedBinding = { ...oneToOneBinding, topology: 'multiplexed' };
  ok(checkIdentityDrop(multiplexedBinding).ok === false,
     "L0's checkIdentityDrop (UNMODIFIED) REFUSES drop for transport:'hyperswarm' on a multiplexed channel");
}

// ---------------------------------------------------------------------------
// (d) shared adapter contract — one seam, three transports
// ---------------------------------------------------------------------------
console.log('\n(d) TRANSPORT_REGISTRY — all adapters share one {name, capabilities, instrument()} contract:\n');
{
  ok(TRANSPORT_REGISTRY.length === 3, `registry has exactly 3 transports (got ${TRANSPORT_REGISTRY.length})`);
  for (const adapter of TRANSPORT_REGISTRY) {
    ok(typeof adapter.name === 'string' && adapter.name.length > 0, `${adapter.name}: has a non-empty name`);
    ok(typeof adapter.instrument === 'function', `${adapter.name}: .instrument is a function`);
    const caps = adapter.capabilities;
    const hasAllCapFields = ['orientation', 'reliable', 'ordered', 'multiplexed', 'intrinsicIdentity'].every((k) => k in caps);
    ok(hasAllCapFields, `${adapter.name}: capabilities has all 5 required fields`);
    ok(caps.orientation === 'message' || caps.orientation === 'stream', `${adapter.name}: orientation is a valid enum value ('${caps.orientation}')`);
  }

  // Disabled-is-a-no-op, proven ONCE across the shared seam for all three,
  // each against a minimally-shaped fake target.
  const fakeDc = { send: () => 'DC_RET', bufferedAmount: 0, addEventListener() {}, removeEventListener() {} };
  const fakeWsGlobal = { WebSocket: class { constructor() {} addEventListener() {} send() { return 'WS_RET'; } } };
  const fakeStream = new FakeNoiseSecretStream(new Uint8Array([1]));

  const targets = { 'webrtc-dc': fakeDc, websocket: fakeWsGlobal, hyperswarm: fakeStream };
  for (const adapter of TRANSPORT_REGISTRY) {
    const sink = new MemorySink();
    const target = targets[adapter.name];
    const before = adapter.name === 'websocket' ? fakeWsGlobal.WebSocket : target.send ?? target.write;
    const inst = adapter.instrument(target, sink, { enabled: false });
    ok(typeof inst.restore === 'function', `${adapter.name}: disabled instrument() still returns a valid Uninstrument`);
    const after = adapter.name === 'websocket' ? fakeWsGlobal.WebSocket : target.send ?? target.write;
    ok(before === after, `${adapter.name}: DISABLED via the shared seam leaves the target UNTOUCHED (same reference)`);
    ok(sink.events.length === 0, `${adapter.name}: DISABLED via the shared seam emits ZERO events`);
  }
}

console.log(`\n${fail === 0 ? 'All transport-framing.test.mjs claims verified.' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
