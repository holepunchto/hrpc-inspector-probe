// L1 probe — Hyperswarm / Holepunch NoiseSecretStream tap.
//
// UNVERIFIABLE HERE: `pear`/`bare` ARE installed in this sandbox (bare
// v1.28.0, measured this session — `bare --version`), but there is no
// running Hyperswarm connection, no second peer, and no network topology to
// dial one (a single interface behind one NAT in the authoring environment;
// two devices on two networks are needed). What follows is verified against a FAKE
// duplex stream that mirrors NoiseSecretStream's documented method shape
// (`.write(buf)`, `.on('data', buf)`, `.on('close')`, `.remotePublicKey`,
// `.writableLength`) — it proves the WRAPPER + PASSTHROUGH logic, not real
// on-device Hyperswarm/UDX behaviour.
//
// PASSTHROUGH IN BOTH DIRECTIONS — this adapter OBSERVES, it never alters the
// application's bytes:
//   outbound: `origWrite(data)` with the app's payload untouched;
//   inbound:  one event per `'data'` chunk, chunk never consumed or reframed.
// A NoiseSecretStream is a raw byte stream, so unlike WebRTC-DC/WebSocket one
// `.write()` is not guaranteed to arrive as one `'data'` event. The tempting fix
// — length-prefix the app's payload on write and reassemble on read (see
// ../transport/framing.ts) — is WRONG here: it only works if BOTH peers run this
// probe, which is not how it is exported (hrpc-inspector/src/index.ts) or
// documented, and otherwise corrupts the app's own protocol on the remote side.
// Consequence, accepted deliberately: an inbound event describes a CHUNK, not
// necessarily a whole message, so `bytes` is exact but the envelope hint is
// best-effort (present when a chunk happens to hold a decodable envelope).
// Length-prefix framing lives ONLY on the dedicated observability channel
// (../exporters/hyperswarm.ts), where this probe owns both ends.
//
// Backpressure analog: DataChannel has `.bufferedAmount`; Node/Bare duplex
// streams have `.writableLength` (bytes queued in the internal buffer, not
// yet flushed to the OS) — same signal, different name. Captured BEFORE
// `.write()`, same as the WebRTC adapter (invariant 4).
//
// Identity: Hyperswarm's Noise handshake authenticates `remotePublicKey`
// before any application data moves (TransportCapabilities.intrinsicIdentity
// = true, ../transport/capabilities.ts) — no signalling-layer peerId is
// required. If the caller doesn't pass one, the hex-encoded public key IS
// the peerId.

import type { EventSink } from '../src/sink.ts';
import { emitSafe } from '../src/sink.ts';
import { byteLength, bestEffortDecode } from './webrtc.ts';
import type { EnvelopeHint, Uninstrument } from './webrtc.ts';
import { isProbeDisabledByBuild } from './env.ts';
import { utf8Decode } from 'hrpc-inspector-protocol/utf8';

export interface MinimalDuplexStream {
  write(data: Uint8Array | string): boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  /** Set once the Noise handshake completes; authenticates the remote peer. */
  remotePublicKey?: Uint8Array | string;
  /** Node/Bare Writable analog of RTCDataChannel.bufferedAmount. */
  writableLength?: number;
}

export interface HyperswarmInstrumentOptions {
  /** Default true. Pass `enabled: false` for a genuine, verified no-op. */
  enabled?: boolean;
  /** Overrides the intrinsic-identity peerId derived from remotePublicKey. */
  peerId?: string;
  now?: () => number;
  decodeEnvelope?: (data: unknown) => EnvelopeHint | undefined;
}

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/** Hex-encode a public key. Same 6-byte-hashable shape our peer-hash tier
 *  (hrpc-inspector-protocol PeerRegistry) already expects for compact peer identifiers. */
export function publicKeyToPeerId(key: Uint8Array | string | undefined): string | undefined {
  if (key === undefined) return undefined;
  if (typeof key === 'string') return key;
  let hex = '';
  for (let i = 0; i < key.length; i++) hex += key[i].toString(16).padStart(2, '0');
  return hex;
}

function toStringIfDecodable(bytes: Uint8Array): string | undefined {
  try {
    return utf8Decode(bytes, { fatal: true });
  } catch {
    return undefined;
  }
}

export function instrumentHyperswarmStream(
  stream: MinimalDuplexStream,
  sink: EventSink,
  opts: HyperswarmInstrumentOptions = {},
): Uninstrument {
  if (opts.enabled === false || isProbeDisabledByBuild()) {
    // Genuine no-op: stream is never touched. Nothing to restore. Same shape
    // whether disabled by caller or by build mode (./env.ts).
    return { restore() {} };
  }

  const now = opts.now ?? defaultNow;
  const decodeEnvelope = opts.decodeEnvelope ?? bestEffortDecode;
  const peerId = opts.peerId ?? publicKeyToPeerId(stream.remotePublicKey) ?? 'unknown-hyperswarm-peer';

  const origWrite = stream.write.bind(stream);
  stream.write = function instrumentedWrite(data: Uint8Array | string): boolean {
    // Invariant 4: writableLength (this transport's bufferedAmount analog)
    // captured BEFORE write, unconditionally.
    const bufferedAmount = stream.writableLength;
    let bytes = 0;
    let env: EnvelopeHint | undefined;
    try {
      bytes = byteLength(data);
      env = decodeEnvelope(data);
    } catch {
      /* never throw from the probe */
    }

    // The tap MUST NOT alter the application's bytes. `data` is handed to
    // origWrite exactly as the app passed it: no length prefix, no re-encoding,
    // no reordering. Framing this payload would prepend 4 bytes to the app's own
    // protocol, and the remote peer — which is NOT required to run this probe
    // (see hrpc-inspector/src/index.ts) — would receive [len][payload]
    // and misparse it. Length-prefix framing belongs ONLY on the dedicated
    // observability channel (../exporters/hyperswarm.ts), never on app data.
    //
    // ONLY the app's own call sits inside this try. Its catch rethrows, because
    // a genuine transport error must reach the app — so nothing probe-internal
    // may live here, or a probe bug would be indistinguishable from a transport
    // failure (and would be reported to the app as one).
    let result: boolean;
    try {
      result = origWrite(data);
    } catch (err) {
      emitSafe(sink, {
        type: 'send.error',
        peerId,
        bytes,
        transport: 'hyperswarm',
        bufferedAmount,
        error: err instanceof Error ? err.message : String(err),
        t: now(),
      });
      throw err;
    }

    // Probe-internal work, outside the rethrowing try. emitSafe never throws.
    emitSafe(sink, {
      type: env?.kind === 'req' ? 'request.start' : 'message.out',
      peerId,
      bytes,
      transport: 'hyperswarm',
      bufferedAmount,
      msgId: env?.msgId,
      corrId: env?.corrId,
      method: env?.method,
      t: now(),
    });
    return result;
  } as MinimalDuplexStream['write'];

  // Inbound is OBSERVE-ONLY, symmetric with the outbound passthrough above.
  // We deliberately do NOT run a length-prefix framer over the app's stream:
  // those bytes are the application's protocol, framed however the application
  // frames it (or not at all), and a framer here would read the app's first 4
  // bytes as a length and desynchronise on the first chunk. So: one event per
  // 'data' chunk, counting bytes and best-effort-decoding a hint. The chunk is
  // never consumed, reframed, buffered or mutated, and this never throws.
  const onData = (chunk: unknown) => {
    try {
      const bytes = byteLength(chunk);
      const asString = typeof chunk === 'string'
        ? chunk
        : chunk instanceof Uint8Array ? toStringIfDecodable(chunk) : undefined;
      const env = decodeEnvelope(asString);
      emitSafe(sink, {
        type: env?.kind === 'res' ? 'request.end' : 'message.in',
        peerId,
        bytes,
        transport: 'hyperswarm',
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
  stream.on('data', onData);

  const onClose = () => {
    emitSafe(sink, { type: 'conn.state', peerId, event: 'close', transport: 'hyperswarm', t: now() });
  };
  stream.on('close', onClose);

  return {
    restore() {
      stream.write = origWrite as MinimalDuplexStream['write'];
      stream.removeListener?.('data', onData);
      stream.removeListener?.('close', onClose);
    },
  };
}
