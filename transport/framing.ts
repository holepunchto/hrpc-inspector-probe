// Stream -> message normalizer. This is THE generalization that lets a
// stream-oriented transport (Hyperswarm NoiseSecretStream, raw TCP) emit the
// identical `onMessage(bytes)` shape a message-oriented transport
// (WebRTC-DC, WebSocket) gives you for free.
//
// Framing: 4-byte big-endian length prefix + payload. Chosen over varint for
// this package because it's branchless to encode/decode and the envelope
// sizes measured elsewhere in this repo (verification/envelope-size.mjs: 90 B
// - 291 B) are nowhere near the varint/fixed-width crossover point (~16 KB) —
// a varint would save nothing here and costs a decode branch on every frame.
//
// CORRECTNESS CLAIM under test (verification/transport-framing.test.mjs):
// arbitrary chunk boundaries — including a chunk that splits a frame's length
// prefix itself — reassemble into exactly the original messages, in order.
// A raw byte stream from a Node/Bare duplex gives NO guarantee that one
// `.write()` on the sender corresponds to one `'data'` event on the
// receiver: the OS/UDX layer may coalesce or fragment arbitrarily. Treating
// a `'data'` chunk as a whole message (the bug this file exists to prevent)
// is silently correct until the first fragmented read, then produces
// corrupted/misaligned messages — see the CONTROL case in the test.

import { utf8Encode } from 'hrpc-inspector-protocol/utf8';

const LENGTH_PREFIX_BYTES = 4;

function toUint8Array(data: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof data === 'string') return utf8Encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Wrap a payload with its 4-byte BE length prefix for wire transmission. */
export function encodeFrame(payload: Uint8Array | ArrayBuffer | string): Uint8Array {
  const bytes = toUint8Array(payload);
  const out = new Uint8Array(LENGTH_PREFIX_BYTES + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, false);
  out.set(bytes, LENGTH_PREFIX_BYTES);
  return out;
}

/** Any object that can absorb an arbitrary byte chunk and emit whole messages. */
export interface Framer {
  /** Feed the next raw chunk exactly as it arrived off the wire (any size, any boundary). */
  push(chunk: Uint8Array | ArrayBuffer | string): void;
  /** Bytes buffered but not yet a complete frame — 0 between messages on a healthy stream. */
  readonly pending: number;
}

/**
 * Reassembles length-prefixed frames out of an arbitrarily-chunked byte
 * stream. Handles every boundary case: a chunk shorter than the 4-byte
 * length prefix, a chunk that ends mid-payload, and a chunk containing two+
 * complete frames back to back.
 */
export class StreamFramer implements Framer {
  private buffer = new Uint8Array(0);
  private readonly onMessage: (bytes: Uint8Array) => void;

  constructor(onMessage: (bytes: Uint8Array) => void) {
    this.onMessage = onMessage;
  }

  get pending(): number {
    return this.buffer.length;
  }

  push(chunk: Uint8Array | ArrayBuffer | string): void {
    this.buffer = concat(this.buffer, toUint8Array(chunk));
    for (;;) {
      if (this.buffer.length < LENGTH_PREFIX_BYTES) return;
      const len = new DataView(this.buffer.buffer, this.buffer.byteOffset, LENGTH_PREFIX_BYTES).getUint32(0, false);
      const total = LENGTH_PREFIX_BYTES + len;
      if (this.buffer.length < total) return; // wait for the rest of this frame
      const message = this.buffer.slice(LENGTH_PREFIX_BYTES, total);
      this.buffer = this.buffer.slice(total);
      this.onMessage(message);
    }
  }
}

/** Passthrough for already-message-oriented transports (WebRTC-DC, WebSocket):
 *  each `push()` call IS one whole message, no reassembly needed. Exists so
 *  callers can use one `Framer` interface regardless of transport orientation. */
export class PassthroughFramer implements Framer {
  readonly pending = 0;
  private readonly onMessage: (bytes: Uint8Array) => void;
  constructor(onMessage: (bytes: Uint8Array) => void) {
    this.onMessage = onMessage;
  }
  push(chunk: Uint8Array | ArrayBuffer | string): void {
    this.onMessage(toUint8Array(chunk));
  }
}

/** Pick the right framer for a transport's orientation. `orientation` comes
 *  from the adapter's `TransportCapabilities` (./capabilities.ts) — the
 *  adapter never has to special-case framing itself. */
export function createFramer(
  orientation: 'message' | 'stream',
  onMessage: (bytes: Uint8Array) => void,
): Framer {
  return orientation === 'stream' ? new StreamFramer(onMessage) : new PassthroughFramer(onMessage);
}
