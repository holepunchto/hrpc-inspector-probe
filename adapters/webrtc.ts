// L1 probe — WebRTC DataChannel + RTCPeerConnection tap.
//
// Invariants enforced here:
//   1. Wrap at the import boundary (these two functions ARE that boundary —
//      call them once per channel/connection, not per send()).
//   2. `this` binding + return value preserved exactly: origSend is bound
//      once and its return value is always the function's return value.
//   3. Never throw from the probe: every emit path is wrapped; decode/byte-
//      length failures are swallowed, not propagated.
//   4. bufferedAmount is read BEFORE origSend runs, unconditionally.
//   5. getStats() output is normalised behind extractRelevant() — see the
//      "UNVERIFIABLE HERE" note above that function for exactly what is and
//      isn't proven about react-native-webrtc's real output.
//
// DISABLED PATH: instrumentDataChannel/instrumentPeerConnection called with
// `{ enabled: false }` (or omitted, since default enabled=true — pass
// enabled:false explicitly to opt out) return immediately WITHOUT touching
// `dc`/`pc` at all: no property reassignment, no addEventListener call, no
// timer. That is the genuine no-op this package's headline guarantee rests
// on. Proven in verification/probe.test.mjs's CONTROL case.

import type { EventSink, L2Event } from '../src/sink.ts';
import { emitSafe } from '../src/sink.ts';
import { isProbeDisabledByBuild } from './env.ts';
import { utf8Encode } from 'hrpc-inspector-protocol/utf8';

// ---------------------------------------------------------------------------
// Wire-level helpers
// ---------------------------------------------------------------------------

export type WireData = string | ArrayBuffer | ArrayBufferView | { size: number };

/** Best-effort byte length across the shapes send()/onmessage may carry. Never throws. */
export function byteLength(data: unknown): number {
  try {
    if (typeof data === 'string') return utf8Encode(data).length;
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data as ArrayBufferView)) return (data as ArrayBufferView).byteLength;
    if (data && typeof (data as { size?: unknown }).size === 'number') {
      return (data as { size: number }).size; // Blob-like
    }
  } catch {
    /* fall through */
  }
  return 0;
}

/** Subset of P2PEnvelope fields the probe cares about; decoding is optional/best-effort. */
export interface EnvelopeHint {
  msgId?: string;
  corrId?: string;
  method?: string;
  kind?: string;
  ts?: number;
  hlc?: string;
}

/**
 * Default decoder: only handles the JSON encodings (`json-full`/`json-short`)
 * and only when `data` is a string, since binary encodings (cbor-compact/
 * cbor-binary) need a MethodRegistry/PeerRegistry the probe doesn't own (see
 * hrpc-inspector-protocol's decode()). Callers who want full-fidelity decoding across
 * all four encodings should pass their own `decodeEnvelope` (e.g. one backed
 * by `decode()` from hrpc-inspector-protocol with the app's live registries).
 *
 * Never throws — returns undefined on anything it can't confidently parse.
 */
export function bestEffortDecode(data: unknown): EnvelopeHint | undefined {
  if (typeof data !== 'string') return undefined;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    if (typeof parsed.corrId !== 'string' && typeof parsed.msgId !== 'string') return undefined;
    return {
      msgId: typeof parsed.msgId === 'string' ? parsed.msgId : undefined,
      corrId: typeof parsed.corrId === 'string' ? parsed.corrId : undefined,
      method: typeof parsed.method === 'string' ? parsed.method : undefined,
      kind: typeof parsed.kind === 'string' ? parsed.kind : undefined,
      ts: typeof parsed.ts === 'number' ? parsed.ts : undefined,
      hlc: typeof parsed.hlc === 'string' ? parsed.hlc : undefined,
    };
  } catch {
    return undefined;
  }
}

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

// ---------------------------------------------------------------------------
// Minimal shapes — real RTCDataChannel/RTCPeerConnection satisfy these
// structurally, and so do the test fakes in verification/probe.test.mjs.
// ---------------------------------------------------------------------------

export interface MinimalDataChannel {
  send(data: WireData): unknown;
  bufferedAmount: number;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  removeEventListener?(type: string, listener: (ev: unknown) => void): void;
}

export interface MinimalPeerConnection {
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  removeEventListener?(type: string, listener: (ev: unknown) => void): void;
  iceConnectionState?: string;
  connectionState?: string;
  iceGatheringState?: string;
  signalingState?: string;
  getStats(): Promise<unknown>;
}

export interface InstrumentOptions {
  /** Default true. Pass `enabled: false` for a genuine, verified no-op. */
  enabled?: boolean;
  now?: () => number;
  decodeEnvelope?: (data: unknown) => EnvelopeHint | undefined;
}

export interface Uninstrument {
  restore(): void;
}

// ---------------------------------------------------------------------------
// instrumentDataChannel
// ---------------------------------------------------------------------------

export function instrumentDataChannel(
  dc: MinimalDataChannel,
  peerId: string,
  sink: EventSink,
  opts: InstrumentOptions = {},
): Uninstrument {
  if (opts.enabled === false || isProbeDisabledByBuild()) {
    // Genuine no-op: dc is never touched. Nothing to restore. Same shape
    // whether disabled by caller (`enabled: false`) or by build mode
    // (`__DEV__ === false` / `NODE_ENV === 'production'` — see ./env.ts and
    // ./env.ts).
    return { restore() {} };
  }

  const now = opts.now ?? defaultNow;
  const decodeEnvelope = opts.decodeEnvelope ?? bestEffortDecode;
  const origSend = dc.send.bind(dc);

  dc.send = function instrumentedSend(data: WireData): unknown {
    // Invariant 4: captured BEFORE send, unconditionally, even if the rest
    // of this wrapper throws.
    const bufferedAmount = dc.bufferedAmount;
    let bytes = 0;
    let env: EnvelopeHint | undefined;
    try {
      bytes = byteLength(data);
      env = decodeEnvelope(data);
    } catch {
      /* never throw from the probe */
    }

    try {
      const result = origSend(data);
      emitSafe(sink, {
        type: env?.kind === 'req' ? 'request.start' : 'message.out',
        peerId,
        bytes,
        transport: 'webrtc-dc',
        bufferedAmount,
        msgId: env?.msgId,
        corrId: env?.corrId,
        method: env?.method,
        t: now(),
      });
      return result;
    } catch (err) {
      // Real send() error: emit for observability, then rethrow unchanged so
      // the app sees exactly the error it would have without the probe.
      emitSafe(sink, {
        type: 'send.error',
        peerId,
        bytes,
        transport: 'webrtc-dc',
        bufferedAmount,
        error: err instanceof Error ? err.message : String(err),
        t: now(),
      });
      throw err;
    }
  } as MinimalDataChannel['send'];

  const onMessage = (ev: unknown) => {
    try {
      const data = (ev as { data?: unknown })?.data;
      const env = decodeEnvelope(data);
      const bytes = byteLength(data);
      emitSafe(sink, {
        type: env?.kind === 'res' ? 'request.end' : 'message.in',
        peerId,
        bytes,
        transport: 'webrtc-dc',
        msgId: env?.msgId,
        corrId: env?.corrId,
        method: env?.method,
        senderTs: env?.ts,
        hlc: env?.hlc,
        t: now(),
      });
    } catch {
      /* never throw from the probe */
    }
  };
  dc.addEventListener('message', onMessage);

  const onBufferedAmountLow = () => {
    emitSafe(sink, { type: 'backpressure.clear', peerId, transport: 'webrtc-dc', t: now() });
  };
  dc.addEventListener('bufferedamountlow', onBufferedAmountLow);

  return {
    restore() {
      dc.send = origSend as MinimalDataChannel['send'];
      dc.removeEventListener?.('message', onMessage);
      dc.removeEventListener?.('bufferedamountlow', onBufferedAmountLow);
    },
  };
}

// ---------------------------------------------------------------------------
// instrumentPeerConnection
// ---------------------------------------------------------------------------

const CONN_EVENTS = [
  'iceconnectionstatechange',
  'connectionstatechange',
  'icegatheringstatechange',
  'signalingstatechange',
] as const;

export interface PeerConnectionInstrumentOptions extends InstrumentOptions {
  pollIntervalMs?: number;
  /** Injectable for tests; defaults to global setInterval/clearInterval. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export function instrumentPeerConnection(
  pc: MinimalPeerConnection,
  peerId: string,
  sink: EventSink,
  opts: PeerConnectionInstrumentOptions = {},
): Uninstrument {
  if (opts.enabled === false || isProbeDisabledByBuild()) {
    return { restore() {} };
  }

  const now = opts.now ?? defaultNow;
  const listeners: Array<[string, (ev: unknown) => void]> = [];

  for (const ev of CONN_EVENTS) {
    const listener = () => {
      emitSafe(sink, {
        type: 'conn.state',
        peerId,
        event: ev,
        ice: pc.iceConnectionState,
        conn: pc.connectionState,
        t: now(),
      });
    };
    pc.addEventListener(ev, listener);
    listeners.push([ev, listener]);
  }

  const intervalMs = opts.pollIntervalMs ?? 1000;
  const setIntervalFn = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  const handle = setIntervalFn(() => {
    pc.getStats()
      .then((stats) => {
        emitSafe(sink, { type: 'conn.stats', peerId, stats: extractRelevant(stats), t: now() });
      })
      .catch((err: unknown) => {
        emitSafe(sink, {
          type: 'send.error',
          peerId,
          transport: 'webrtc-pc',
          error: err instanceof Error ? err.message : String(err),
          t: now(),
        });
      });
  }, intervalMs);

  return {
    restore() {
      for (const [ev, listener] of listeners) pc.removeEventListener?.(ev, listener);
      clearIntervalFn(handle);
    },
  };
}

// ---------------------------------------------------------------------------
// getStats() normaliser
// ---------------------------------------------------------------------------
//
// UNVERIFIABLE HERE: the exact field-level divergence of a real
// react-native-webrtc getStats() call (e.g. whether a given RN-webrtc/RN
// version returns a Map-like RTCStatsReport, a plain array, or nests fields
// under different names such as `roundTripTime` vs the spec's
// `currentRoundTripTime`) cannot be verified in this sandbox — there is no
// react-native-webrtc install and no device/simulator here (no
// toolchain). What IS verified below (verification/probe.test.mjs) is that
// this normaliser produces the identical NormalisedStats shape for two
// concrete, plausible container shapes (Map-like per the W3C spec, and a
// plain array as multiple community reports describe older
// react-native-webrtc versions returning) — i.e. the ADAPTER LOGIC is
// covered, not the real native binding's behaviour.

export interface CandidatePairInfo {
  state?: string;
  nominated?: boolean;
  localCandidateType?: string;
  remoteCandidateType?: string;
  currentRoundTripTimeMs?: number;
  bytesSent?: number;
  bytesReceived?: number;
  relayed: boolean;
}

export interface NormalisedStats {
  candidatePair?: CandidatePairInfo;
  packetsLost?: number;
  packetsReceived?: number;
  containerShape: 'map' | 'array' | 'object' | 'unknown';
}

type StatEntry = Record<string, unknown>;

function toEntries(report: unknown): { entries: StatEntry[]; shape: NormalisedStats['containerShape'] } {
  if (report == null) return { entries: [], shape: 'unknown' };
  // Array MUST be checked before the Map-like duck-type check below:
  // Array.prototype also has a `.values()` method, so checking `.values`
  // first would misclassify a plain array (the documented rn-webrtc-
  // divergent shape) as "map".
  if (Array.isArray(report)) {
    return { entries: report as StatEntry[], shape: 'array' };
  }
  const maybeMap = report as { values?: unknown };
  if (typeof maybeMap.values === 'function') {
    return { entries: Array.from((maybeMap.values as () => Iterable<StatEntry>)()), shape: 'map' };
  }
  if (typeof report === 'object') {
    return { entries: Object.values(report as Record<string, StatEntry>), shape: 'object' };
  }
  return { entries: [], shape: 'unknown' };
}

function pickCandidatePair(entries: StatEntry[]): StatEntry | undefined {
  const pairs = entries.filter((e) => e.type === 'candidate-pair');
  if (pairs.length === 0) return undefined;
  const selected = pairs.find((p) => p.selected === true);
  if (selected) return selected;
  const nominatedSucceeded = pairs.find(
    (p) => p.nominated === true && (p.state === 'succeeded' || p.state === 'completed'),
  );
  if (nominatedSucceeded) return nominatedSucceeded;
  return pairs[0];
}

/** Normalise a getStats() result into the shape the UI consumes, regardless of platform. */
export function extractRelevant(report: unknown): NormalisedStats {
  const { entries, shape } = toEntries(report);

  let candidatePair: CandidatePairInfo | undefined;
  const pair = pickCandidatePair(entries);
  if (pair) {
    const localId = pair.localCandidateId as string | undefined;
    const remoteId = pair.remoteCandidateId as string | undefined;
    const localCand = entries.find((e) => e.type === 'local-candidate' && e.id === localId);
    const remoteCand = entries.find((e) => e.type === 'remote-candidate' && e.id === remoteId);

    // Spec field is `currentRoundTripTime` in SECONDS. Some divergent shapes
    // report `roundTripTime` — normalise both to milliseconds here so the UI
    // never has to guess which field/unit it received.
    const rttSeconds =
      typeof pair.currentRoundTripTime === 'number'
        ? pair.currentRoundTripTime
        : typeof pair.roundTripTime === 'number'
          ? pair.roundTripTime
          : undefined;

    const localCandidateType =
      (localCand?.candidateType as string | undefined) ?? (pair.localCandidateType as string | undefined);

    candidatePair = {
      state: pair.state as string | undefined,
      nominated: pair.nominated as boolean | undefined,
      localCandidateType,
      remoteCandidateType:
        (remoteCand?.candidateType as string | undefined) ?? (pair.remoteCandidateType as string | undefined),
      currentRoundTripTimeMs: rttSeconds !== undefined ? rttSeconds * 1000 : undefined,
      bytesSent: pair.bytesSent as number | undefined,
      bytesReceived: pair.bytesReceived as number | undefined,
      relayed: localCandidateType === 'relay',
    };
  }

  let packetsLost: number | undefined;
  let packetsReceived: number | undefined;
  for (const e of entries) {
    if (e.type === 'inbound-rtp') {
      if (typeof e.packetsLost === 'number') packetsLost = (packetsLost ?? 0) + e.packetsLost;
      if (typeof e.packetsReceived === 'number') packetsReceived = (packetsReceived ?? 0) + e.packetsReceived;
    }
  }

  return { candidatePair, packetsLost, packetsReceived, containerShape: shape };
}

export type { EventSink, L2Event };
