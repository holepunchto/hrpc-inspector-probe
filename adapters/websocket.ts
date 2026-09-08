// L1 probe — WebSocket signalling tap.
//
// Wraps at the MODULE IMPORT BOUNDARY: call `instrumentWebSocket(globalObj,
// sink)` once, at app entry, before any module constructs a WebSocket. Every
// `new WebSocket(url)` anywhere in the app is then instrumented without a
// single call site being touched (invariant 1).
//
// DISABLED PATH: `{ enabled: false }` returns immediately without reassigning
// `globalObj.WebSocket` at all — a genuine no-op, proven in
// verification/probe.test.mjs.

import type { EventSink } from '../src/sink.ts';
import { emitSafe } from '../src/sink.ts';
import { byteLength } from './webrtc.ts';
import { isProbeDisabledByBuild } from './env.ts';

export interface MinimalWebSocketInstance {
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  removeEventListener?(type: string, listener: (ev: unknown) => void): void;
  send(data: unknown): unknown;
  readyState: number;
}

export type MinimalWebSocketCtor = new (url: string | URL, protocols?: string | string[]) => MinimalWebSocketInstance;

export interface WebSocketGlobal {
  WebSocket: MinimalWebSocketCtor;
}

export interface WebSocketInstrumentOptions {
  /** Default true. Pass `enabled: false` for a genuine, verified no-op. */
  enabled?: boolean;
  now?: () => number;
  /** Derive a peer/label from the connection URL. Defaults to the URL itself. */
  peerIdFromUrl?: (url: string) => string;
}

export interface Uninstrument {
  restore(): void;
}

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * Wraps `globalObj.WebSocket` in place. Pass the real global object
 * (`globalThis` in RN/browser/Node) at app entry, before any other module
 * has imported/captured a reference to `WebSocket`.
 */
export function instrumentWebSocket(
  globalObj: WebSocketGlobal,
  sink: EventSink,
  opts: WebSocketInstrumentOptions = {},
): Uninstrument {
  if (opts.enabled === false || isProbeDisabledByBuild()) {
    // Genuine no-op: globalObj.WebSocket is never reassigned, same shape as
    // the `enabled: false` path (see ./env.ts).
    return { restore() {} };
  }

  const now = opts.now ?? defaultNow;
  const peerIdFromUrl = opts.peerIdFromUrl ?? ((url: string) => url);
  const OriginalWebSocket = globalObj.WebSocket;

  class InstrumentedWebSocket extends (OriginalWebSocket as unknown as { new (...args: unknown[]): MinimalWebSocketInstance }) {
    constructor(...args: unknown[]) {
      super(...args);
      const url = String(args[0]);
      const peerId = peerIdFromUrl(url);

      try {
        emitSafe(sink, { type: 'ws.open.attempt', peerId, url, transport: 'websocket', t: now() });

        this.addEventListener('open', () => {
          emitSafe(sink, { type: 'ws.open', peerId, url, transport: 'websocket', t: now() });
        });

        this.addEventListener('close', (ev: unknown) => {
          const e = ev as { code?: number; reason?: string };
          emitSafe(sink, {
            type: 'ws.close',
            peerId,
            url,
            transport: 'websocket',
            code: e?.code,
            reason: e?.reason,
            t: now(),
          });
        });

        this.addEventListener('error', () => {
          emitSafe(sink, { type: 'ws.error', peerId, url, transport: 'websocket', error: 'websocket error', t: now() });
        });

        this.addEventListener('message', (ev: unknown) => {
          try {
            const data = (ev as { data?: unknown })?.data;
            emitSafe(sink, {
              type: 'ws.message.in',
              peerId,
              url,
              transport: 'websocket',
              bytes: byteLength(data),
              t: now(),
            });
          } catch {
            /* never throw from the probe */
          }
        });

        // Invariant 2: bound once, return value and `this` preserved exactly.
        const origSend = this.send.bind(this);
        this.send = (data: unknown) => {
          let bytes = 0;
          try {
            bytes = byteLength(data);
          } catch {
            /* never throw from the probe */
          }
          try {
            const result = origSend(data);
            emitSafe(sink, { type: 'ws.message.out', peerId, url, transport: 'websocket', bytes, t: now() });
            return result;
          } catch (err) {
            emitSafe(sink, {
              type: 'send.error',
              peerId,
              url,
              transport: 'websocket',
              bytes,
              error: err instanceof Error ? err.message : String(err),
              t: now(),
            });
            throw err;
          }
        };
      } catch {
        // Never let probe wiring crash the app's WebSocket construction.
      }
    }
  }

  globalObj.WebSocket = InstrumentedWebSocket as unknown as MinimalWebSocketCtor;

  return {
    restore() {
      globalObj.WebSocket = OriginalWebSocket;
    },
  };
}
