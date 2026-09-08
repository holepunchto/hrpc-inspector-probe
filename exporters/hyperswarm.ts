// Exporter: ships batched L2 events from the collector TO the Pear/Hyperswarm hub.
//
// This is the piece that "attaches" a mobile app to the hub. Data flow:
//
//   probe adapter → EventSink → Collector → BatchFlusher(onFlush) → THIS exporter → hub stream
//
// The hub (pear-app/index.js) reads the other end with the same 4-byte length-prefix
// FrameReader, so this exporter's output IS the hub's input — proven byte-for-byte in
// verification/hub-e2e.test.mjs.
//
// Runtime note: `stream` is a Hyperswarm `NoiseSecretStream` (a Node/Bare duplex). On
// React Native this runs inside a `react-native-bare-kit` worklet — writing on-device is
// UNVERIFIABLE HERE (no RN toolchain/device, C15/C17). The wire contract below is verified.

import { encodeFrame } from '../transport/framing.ts';
import { utf8Encode } from 'hrpc-inspector-protocol/utf8';

/** Minimal duplex-write surface. NoiseSecretStream / TCP socket / any Node duplex satisfies it. */
export interface WritableStreamLike {
  write(bytes: Uint8Array): unknown;
}

export interface HyperswarmExporterOptions {
  /** Serialize one L2 event to bytes. Default JSON; swap for CBOR/hrpc-inspector-protocol if desired. */
  encode?: (event: unknown) => Uint8Array;
  /** Optional error hook; the exporter NEVER throws into the app (monitor must not crash transport). */
  onError?: (err: unknown) => void;
}

const jsonEncode = (event: unknown): Uint8Array =>
  utf8Encode(JSON.stringify(event));

export interface HyperswarmExporter {
  /** Frame-and-write one flushed batch. Wire this as BatchFlusher's `onFlush`. */
  export(batch: unknown[]): void;
}

/**
 * Build an exporter that length-prefix-frames each event in a batch and writes it to the
 * hub connection. One frame per event, so the hub can decode incrementally.
 */
export function createHyperswarmExporter(
  stream: WritableStreamLike,
  opts: HyperswarmExporterOptions = {},
): HyperswarmExporter {
  const encode = opts.encode ?? jsonEncode;
  return {
    export(batch: unknown[]): void {
      for (const event of batch) {
        try {
          stream.write(encodeFrame(encode(event)));
        } catch (err) {
          // Swallow: the observability path must never crash the transport it rides on
          // (same guarantee as emitSafe in the probe layer).
          opts.onError?.(err);
        }
      }
    },
  };
}
