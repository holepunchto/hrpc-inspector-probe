// Proves the hrpc-inspector-probe L1 adapters (adapters/) hold their
// contract:
//
//   (a) instrumentDataChannel: send is tapped with correct bytes + the
//       bufferedAmount PRESENT BEFORE origSend ran; `this`/return value
//       preserved.
//   (b) onmessage (`message` listener) is tapped.
//   (c) error path: origSend throwing emits `send.error` AND still rethrows
//       the original error unchanged (probe never swallows real errors).
//   (d) backpressure: `bufferedamountlow` emits `backpressure.clear`.
//   (e) extractRelevant() normalises BOTH a browser-standard Map-like
//       RTCStatsReport AND a plausible react-native-webrtc-divergent plain
//       array shape to the identical NormalisedStats shape. See the
//       "UNVERIFIABLE HERE" comment in adapters/webrtc.ts: this proves the
//       ADAPTER LOGIC, not real react-native-webrtc device behaviour (no
//       toolchain/device in this sandbox).
//   (f) instrumentWebSocket: wraps the global constructor, taps send/message/
//       error/close.
//   (g) CONTROL — with `enabled: false`, every instrument*() call is a
//       genuine no-op: original send is called with IDENTICAL args, SAME
//       return value, SAME call count, and ZERO events emitted. This is the
//       headline guarantee: without this control, a probe
//       that happens to pass (a)-(f) could still corrupt the disabled path.
//
// No real WebRTC/WebSocket stack exists in this sandbox (no
// toolchain). The fakes below implement the real method SHAPES
// (send/bufferedAmount/addEventListener, getStats() Promise, WebSocket
// constructor+send+addEventListener) to test the WRAPPER LOGIC only.

import {
  instrumentDataChannel,
  instrumentPeerConnection,
  extractRelevant,
  byteLength,
} from '../adapters/webrtc.ts';
import { instrumentWebSocket } from '../adapters/websocket.ts';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  PASS  ' + m)) : (fail++, console.log('  FAIL  ' + m)); };

console.log('probe.test.mjs — hrpc-inspector-probe L1 adapter contract\n');

// ---------------------------------------------------------------------------
// Fakes: real METHOD SHAPES, no real transport. Labelled per invariant.
// ---------------------------------------------------------------------------

class FakeDataChannel {
  constructor() {
    this.bufferedAmount = 0;
    this._listeners = new Map();
    this.sendCalls = [];
    this._sendImpl = (data) => { this.sendCalls.push(data); return 'ORIGINAL_RETURN'; };
  }
  send(data) { return this._sendImpl(data); }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const arr = this._listeners.get(type) || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatch(type, ev) {
    for (const fn of this._listeners.get(type) || []) fn(ev);
  }
}

class MemorySink {
  constructor() { this.events = []; }
  emit(e) { this.events.push(e); }
}

class ThrowingSink {
  emit() { throw new Error('sink is broken'); }
}

// A collector.emit that RECORDS bufferedAmount at the moment it fires, so we
// can compare against a value mutated by the origSend implementation itself
// (proves "before send", not just "some snapshot").
class FakeDataChannelWithMutatingSend extends FakeDataChannel {
  constructor() {
    super();
    this._sendImpl = (data) => {
      this.sendCalls.push(data);
      this.bufferedAmount += 999; // simulate the queue growing DURING send
      return 'ORIGINAL_RETURN';
    };
  }
}

// ---------------------------------------------------------------------------
// (a) send is tapped: bytes correct, bufferedAmount captured BEFORE send,
//     `this`/return value preserved
// ---------------------------------------------------------------------------
console.log('(a) instrumentDataChannel — send tap, bufferedAmount-before-send, this/return preserved:\n');
{
  const dc = new FakeDataChannelWithMutatingSend();
  dc.bufferedAmount = 42; // the queue depth THIS message actually faced
  const sink = new MemorySink();
  instrumentDataChannel(dc, 'peer-A', sink);

  const ret = dc.send('{"corrId":"c1","msgId":"m1","method":"blocks.fetch","kind":"req"}');

  ok(ret === 'ORIGINAL_RETURN', 'send() returns the ORIGINAL return value unchanged');
  ok(dc.sendCalls.length === 1 && dc.sendCalls[0] === '{"corrId":"c1","msgId":"m1","method":"blocks.fetch","kind":"req"}',
     'origSend received the identical data argument');
  ok(sink.events.length === 1, 'exactly one event emitted for one send()');
  const e = sink.events[0];
  ok(e.type === 'request.start', "kind:'req' -> type 'request.start'");
  ok(e.bufferedAmount === 42, `bufferedAmount captured BEFORE send (=42, not ${dc.bufferedAmount} post-send) — measured ${e.bufferedAmount}`);
  ok(e.bytes === byteLength('{"corrId":"c1","msgId":"m1","method":"blocks.fetch","kind":"req"}'),
     `bytes matches measured UTF-8 length (${e.bytes} B)`);
  ok(e.corrId === 'c1' && e.msgId === 'm1' && e.method === 'blocks.fetch', 'envelope hint fields (corrId/msgId/method) decoded from JSON payload');
  ok(e.peerId === 'peer-A' && e.transport === 'webrtc-dc', 'peerId/transport tagged correctly');
  ok(typeof e.t === 'number', 't is a timestamp');
}

// Non-req kind -> message.out
{
  const dc = new FakeDataChannel();
  const sink = new MemorySink();
  instrumentDataChannel(dc, 'peer-A', sink);
  dc.send('{"corrId":"c2","kind":"event"}');
  ok(sink.events[0].type === 'message.out', "kind:'event' -> type 'message.out' (not request.start)");
}

// Opaque (non-JSON / binary) payload never throws and still measures bytes
{
  const dc = new FakeDataChannel();
  const sink = new MemorySink();
  instrumentDataChannel(dc, 'peer-A', sink);
  const buf = new Uint8Array([1, 2, 3, 4]).buffer;
  dc.send(buf);
  ok(sink.events.length === 1 && sink.events[0].bytes === 4, 'opaque ArrayBuffer payload: no decode, bytes still measured (4 B)');
  ok(sink.events[0].corrId === undefined, 'no envelope hint fields when payload cannot be decoded');
}

// ---------------------------------------------------------------------------
// (b) onmessage is tapped
// ---------------------------------------------------------------------------
console.log('\n(b) instrumentDataChannel — message listener tap:\n');
{
  const dc = new FakeDataChannel();
  const sink = new MemorySink();
  instrumentDataChannel(dc, 'peer-B', sink);
  dc.dispatch('message', { data: '{"corrId":"c9","msgId":"m9","method":"blocks.fetch","kind":"res","ts":1234,"hlc":"1000:0:AAAAAA"}' });
  ok(sink.events.length === 1, 'message event tapped');
  const e = sink.events[0];
  ok(e.type === 'request.end', "kind:'res' -> type 'request.end'");
  ok(e.corrId === 'c9' && e.senderTs === 1234 && e.hlc === '1000:0:AAAAAA', 'senderTs/hlc/corrId carried through from the envelope hint');
}
{
  const dc = new FakeDataChannel();
  const sink = new MemorySink();
  instrumentDataChannel(dc, 'peer-B', sink);
  dc.dispatch('message', { data: '{"corrId":"c10","kind":"event"}' });
  ok(sink.events[0].type === 'message.in', "kind:'event' incoming -> type 'message.in'");
}

// ---------------------------------------------------------------------------
// (c) error path
// ---------------------------------------------------------------------------
console.log('\n(c) instrumentDataChannel — error path emits AND rethrows unchanged:\n');
{
  class ThrowingDataChannel extends FakeDataChannel {
    constructor() { super(); this._sendImpl = () => { throw new Error('SCTP channel closed'); }; }
  }
  const dc = new ThrowingDataChannel();
  const sink = new MemorySink();
  instrumentDataChannel(dc, 'peer-C', sink);
  let caught;
  try { dc.send('x'); } catch (e) { caught = e; }
  ok(caught instanceof Error && caught.message === 'SCTP channel closed', 'original error rethrown UNCHANGED — probe never swallows real errors');
  ok(sink.events.length === 1 && sink.events[0].type === 'send.error', 'send.error event emitted');
  ok(sink.events[0].error === 'SCTP channel closed', 'error message captured on the event');
}

// A broken sink must not crash the app's send — invariant 3.
{
  const dc = new FakeDataChannel();
  const sink = new ThrowingSink();
  instrumentDataChannel(dc, 'peer-D', sink);
  let threw = false;
  let ret;
  try { ret = dc.send('hello'); } catch { threw = true; }
  ok(!threw, 'CONTROL: a sink that throws on emit() does NOT crash send() — probe never propagates its own bugs');
  ok(ret === 'ORIGINAL_RETURN' && dc.sendCalls.length === 1, 'send still ran and returned correctly despite the broken sink');
}

// ---------------------------------------------------------------------------
// (d) backpressure
// ---------------------------------------------------------------------------
console.log('\n(d) instrumentDataChannel — bufferedamountlow backpressure clear:\n');
{
  const dc = new FakeDataChannel();
  const sink = new MemorySink();
  instrumentDataChannel(dc, 'peer-E', sink);
  dc.dispatch('bufferedamountlow', {});
  ok(sink.events.length === 1 && sink.events[0].type === 'backpressure.clear', "'bufferedamountlow' -> type 'backpressure.clear'");
  ok(sink.events[0].peerId === 'peer-E', 'peerId tagged on backpressure event');
}

// ---------------------------------------------------------------------------
// (e) getStats() normaliser — browser Map-like vs rn-webrtc-divergent array
// ---------------------------------------------------------------------------
console.log('\n(e) extractRelevant — normalises divergent getStats() shapes to the SAME output:\n');
{
  // Browser-standard: RTCStatsReport is Map-like (has .values()).
  const browserStats = new Map([
    ['pair1', {
      type: 'candidate-pair', id: 'pair1', state: 'succeeded', nominated: true,
      localCandidateId: 'local1', remoteCandidateId: 'remote1',
      currentRoundTripTime: 0.042, bytesSent: 1000, bytesReceived: 2000,
    }],
    ['local1', { type: 'local-candidate', id: 'local1', candidateType: 'srflx' }],
    ['remote1', { type: 'remote-candidate', id: 'remote1', candidateType: 'host' }],
    ['rtp1', { type: 'inbound-rtp', packetsLost: 3, packetsReceived: 100 }],
  ]);

  // Plausible react-native-webrtc-divergent shape: plain array, `roundTripTime`
  // (seconds) instead of `currentRoundTripTime`. See UNVERIFIABLE HERE note in
  // adapters/webrtc.ts — this is a documented community-reported divergence
  // pattern, not verified against a real device in this sandbox.
  const rnStats = [
    { type: 'candidate-pair', id: 'pair1', state: 'succeeded', nominated: true,
      localCandidateId: 'local1', remoteCandidateId: 'remote1',
      roundTripTime: 0.042, bytesSent: 1000, bytesReceived: 2000 },
    { type: 'local-candidate', id: 'local1', candidateType: 'srflx' },
    { type: 'remote-candidate', id: 'remote1', candidateType: 'host' },
    { type: 'inbound-rtp', packetsLost: 3, packetsReceived: 100 },
  ];

  const a = extractRelevant(browserStats);
  const b = extractRelevant(rnStats);

  ok(a.containerShape === 'map', 'browser shape detected as containerShape "map"');
  ok(b.containerShape === 'array', 'rn-webrtc-divergent shape detected as containerShape "array"');

  const comparable = (x) => ({ ...x, containerShape: undefined });
  ok(JSON.stringify(comparable(a)) === JSON.stringify(comparable(b)),
     'BOTH shapes normalise to the IDENTICAL NormalisedStats output (excluding containerShape tag)');

  ok(a.candidatePair.currentRoundTripTimeMs === 42, 'currentRoundTripTime (seconds) -> 42ms');
  ok(b.candidatePair.currentRoundTripTimeMs === 42, 'roundTripTime (seconds, divergent field name) -> also 42ms');
  ok(a.candidatePair.localCandidateType === 'srflx' && a.candidatePair.relayed === false, 'srflx candidate correctly marked NOT relayed');
  ok(a.packetsLost === 3 && a.packetsReceived === 100, 'inbound-rtp packet counters summed');

  // Relay case
  const relayStats = [
    { type: 'candidate-pair', id: 'p', state: 'succeeded', nominated: true, localCandidateId: 'l', remoteCandidateId: 'r' },
    { type: 'local-candidate', id: 'l', candidateType: 'relay' },
    { type: 'remote-candidate', id: 'r', candidateType: 'host' },
  ];
  ok(extractRelevant(relayStats).candidatePair.relayed === true, 'relay candidate correctly marked relayed=true (the "why is this slow" signal)');

  // Empty/garbage input never throws
  let threw = false;
  try { extractRelevant(null); extractRelevant(undefined); extractRelevant(42); extractRelevant('garbage'); } catch { threw = true; }
  ok(!threw, 'extractRelevant() never throws on null/undefined/garbage input (untrusted-shape invariant)');
}

// instrumentPeerConnection wiring: conn.state + conn.stats via injectable timer
console.log('\n(e2) instrumentPeerConnection — conn.state events + getStats poll wiring:\n');
{
  class FakePeerConnection {
    constructor() {
      this._listeners = new Map();
      this.iceConnectionState = 'checking';
      this.connectionState = 'connecting';
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const arr = this._listeners.get(type) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }
    dispatch(type) { for (const fn of this._listeners.get(type) || []) fn(); }
    async getStats() { return new Map([['p', { type: 'candidate-pair', state: 'succeeded', nominated: true }]]); }
  }

  const pc = new FakePeerConnection();
  const sink = new MemorySink();
  let scheduled;
  const inst = instrumentPeerConnection(pc, 'peer-F', sink, {
    setInterval: (fn) => { scheduled = fn; return 'handle'; },
    clearInterval: () => {},
  });

  pc.iceConnectionState = 'connected';
  pc.dispatch('iceconnectionstatechange');
  ok(sink.events.some((e) => e.type === 'conn.state' && e.event === 'iceconnectionstatechange' && e.ice === 'connected'),
     'iceconnectionstatechange tapped with current ice state');

  ok(typeof scheduled === 'function', 'getStats poll scheduled via injected setInterval (no real 1s timer needed for the test)');
  await scheduled();
  ok(sink.events.some((e) => e.type === 'conn.stats' && e.stats.candidatePair), 'conn.stats emitted with normalised stats after poll tick');

  inst.restore();
}

// ---------------------------------------------------------------------------
// (f) WebSocket signalling tap
// ---------------------------------------------------------------------------
console.log('\n(f) instrumentWebSocket — wraps global constructor, taps send/message/close/error:\n');
{
  class FakeWebSocket {
    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      this._listeners = new Map();
      this.sendCalls = [];
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const arr = this._listeners.get(type) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }
    dispatch(type, ev) { for (const fn of this._listeners.get(type) || []) fn(ev); }
    send(data) { this.sendCalls.push(data); return 'WS_RETURN'; }
  }

  const globalObj = { WebSocket: FakeWebSocket };
  const OriginalRef = globalObj.WebSocket;
  const sink = new MemorySink();
  const inst = instrumentWebSocket(globalObj, sink);

  ok(globalObj.WebSocket !== OriginalRef, 'global WebSocket constructor is replaced (module-import-boundary wrap)');

  const ws = new globalObj.WebSocket('wss://signal.example/room1');
  ok(ws instanceof OriginalRef, 'instrumented instance is STILL an instanceof the original class (subclassing preserves identity)');
  ok(sink.events.some((e) => e.type === 'ws.open.attempt' && e.url === 'wss://signal.example/room1'), 'ws.open.attempt emitted on construction');

  ws.dispatch('open');
  ok(sink.events.some((e) => e.type === 'ws.open'), 'ws.open emitted');

  const ret = ws.send('hello-signal');
  ok(ret === 'WS_RETURN', 'ws.send() return value preserved');
  ok(ws.sendCalls[0] === 'hello-signal', 'ws.send() called with identical arg');
  ok(sink.events.some((e) => e.type === 'ws.message.out' && e.bytes === byteLength('hello-signal')), 'ws.message.out emitted with correct byte length');

  ws.dispatch('message', { data: 'incoming-signal' });
  ok(sink.events.some((e) => e.type === 'ws.message.in' && e.bytes === byteLength('incoming-signal')), 'ws.message.in emitted with correct byte length');

  ws.dispatch('error');
  ok(sink.events.some((e) => e.type === 'ws.error'), 'ws.error emitted');

  ws.dispatch('close', { code: 1000, reason: 'done' });
  ok(sink.events.some((e) => e.type === 'ws.close' && e.code === 1000 && e.reason === 'done'), 'ws.close emitted with code/reason');

  inst.restore();
  ok(globalObj.WebSocket === OriginalRef, 'restore() puts the ORIGINAL constructor back');
}

// ---------------------------------------------------------------------------
// (g) CONTROL — disabled probe is a genuine no-op, for ALL THREE instrument*()
// ---------------------------------------------------------------------------
console.log('\n(g) CONTROL — disabled probe is a genuine no-op (headline guarantee):\n');
{
  const dc = new FakeDataChannel();
  const originalSendRef = dc.send;
  const sink = new MemorySink();
  const inst = instrumentDataChannel(dc, 'peer-X', sink, { enabled: false });

  ok(dc.send === originalSendRef, 'DISABLED: dc.send is left as the EXACT original reference (not even reassigned to a passthrough)');
  const ret = dc.send('payload-when-disabled');
  ok(ret === 'ORIGINAL_RETURN', 'DISABLED: send() still returns the original return value');
  ok(dc.sendCalls.length === 1 && dc.sendCalls[0] === 'payload-when-disabled', 'DISABLED: origSend called once with the identical arg');
  dc.dispatch('message', { data: 'x' });
  dc.dispatch('bufferedamountlow', {});
  ok(sink.events.length === 0, 'DISABLED: ZERO events emitted across send + message + bufferedamountlow');
  inst.restore(); // must not throw even though nothing was installed
  ok(true, 'DISABLED: restore() on a no-op instrument is itself a no-op (does not throw)');
}
{
  class FakePeerConnection {
    constructor() { this._listeners = new Map(); this.addEventListenerCalls = 0; }
    addEventListener() { this.addEventListenerCalls++; }
    removeEventListener() {}
    async getStats() { return new Map(); }
  }
  const pc = new FakePeerConnection();
  const sink = new MemorySink();
  let intervalCalls = 0;
  instrumentPeerConnection(pc, 'peer-Y', sink, {
    enabled: false,
    setInterval: () => { intervalCalls++; return 'h'; },
  });
  ok(pc.addEventListenerCalls === 0, 'DISABLED: instrumentPeerConnection never calls addEventListener');
  ok(intervalCalls === 0, 'DISABLED: instrumentPeerConnection never schedules the getStats poll');
}
{
  class FakeWebSocket {
    constructor(url) { this.url = String(url); }
    addEventListener() {}
    send(data) { return 'WS_RETURN_DISABLED'; }
  }
  const globalObj = { WebSocket: FakeWebSocket };
  const originalRef = globalObj.WebSocket;
  const sink = new MemorySink();
  instrumentWebSocket(globalObj, sink, { enabled: false });
  ok(globalObj.WebSocket === originalRef, 'DISABLED: global WebSocket constructor is left completely untouched');
  const ws = new globalObj.WebSocket('wss://x');
  ok(ws.send('y') === 'WS_RETURN_DISABLED', 'DISABLED: send() behaves exactly as the un-instrumented original');
  ok(sink.events.length === 0, 'DISABLED: zero events emitted for WebSocket construction/send');
}

console.log('\n(h) CONTROL — build-mode gate (G3 hardening, adapters/env.ts):\n');

{
  // NODE_ENV=production is the isProbeDisabledByBuild() signal available
  // outside RN (no `__DEV__` global exists in this plain-Node harness — see
  // env.ts's comment on why absence of a signal must NOT disable the probe).
  // Restored in a finally so this block can't leak state into later tests.
  const savedNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';

    const dc = new FakeDataChannel();
    const originalSend = dc.send;
    const sink = new MemorySink();
    instrumentDataChannel(dc, 'peer-Z', sink); // no `enabled: false` passed — build gate alone must disable it
    ok(dc.send === originalSend, 'BUILD-GATED: dc.send left untouched when NODE_ENV=production, even without enabled:false');
    dc.send('x');
    ok(dc.sendCalls.length === 1 && dc.sendCalls[0] === 'x', 'BUILD-GATED: send still forwards to the original implementation');
    ok(sink.events.length === 0, 'BUILD-GATED: zero events emitted');

    const globalObj = { WebSocket: class { addEventListener() {} send() { return 'R'; } } };
    const originalCtor = globalObj.WebSocket;
    instrumentWebSocket(globalObj, sink);
    ok(globalObj.WebSocket === originalCtor, 'BUILD-GATED: global WebSocket constructor left untouched under NODE_ENV=production');
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  }

  // CONTROL for the control: with NODE_ENV restored (unset in this harness),
  // the exact same call DOES instrument — proving (h) tested the gate, not a
  // permanently-broken adapter.
  const dc2 = new FakeDataChannel();
  const originalSend2 = dc2.send;
  const sink2 = new MemorySink();
  instrumentDataChannel(dc2, 'peer-Z2', sink2);
  ok(dc2.send !== originalSend2, 'CONTROL: outside production, instrumentDataChannel DOES wrap send (gate is not a permanent no-op)');
}

console.log(`\n${fail === 0 ? 'All probe.test.mjs claims verified.' : fail + ' FAILED'}`);
process.exit(fail ? 1 : 0);
