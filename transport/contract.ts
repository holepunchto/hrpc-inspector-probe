// The ONE seam every transport implements. `core/` (L2) depends only on
// `EventSink`/`L2Event` (../src/sink.ts) — never on this interface and never
// on any per-transport type — which is what makes the layering claim literal:
// adding a transport touches L1 only.
//
// This file does not change adapter call signatures that already shipped
// (instrumentDataChannel/instrumentWebSocket keep taking `peerId` as an
// explicit, required positional arg, since WebRTC-DC/WebSocket have no
// intrinsic identity to fall back on). Instead it defines the shape every
// adapter can be ADAPTED TO — `(target, sink, opts) -> Uninstrument`, `opts.
// peerId` optional — and a registry proving all three concrete adapters
// (webrtc-dc, websocket, hyperswarm) satisfy it identically, including the
// disabled-is-a-no-op guarantee. See verification/transport-framing.test.mjs
// section (d).

import type { EventSink } from '../src/sink.ts';
import type { TransportCapabilities } from './capabilities.ts';
import type { Uninstrument } from '../adapters/webrtc.ts';
import { instrumentDataChannel, type MinimalDataChannel } from '../adapters/webrtc.ts';
import { instrumentWebSocket, type WebSocketGlobal } from '../adapters/websocket.ts';
import { instrumentHyperswarmStream, type MinimalDuplexStream } from '../adapters/hyperswarm.ts';
import { WEBRTC_DC_CAPABILITIES, WEBSOCKET_CAPABILITIES, HYPERSWARM_CAPABILITIES } from './capabilities.ts';

export interface AdapterOptions {
  peerId?: string;
  enabled?: boolean;
  now?: () => number;
}

export interface TransportAdapter<Target = unknown> {
  name: string;
  capabilities: TransportCapabilities;
  instrument(target: Target, sink: EventSink, opts?: AdapterOptions): Uninstrument;
}

export const webrtcDataChannelAdapter: TransportAdapter<MinimalDataChannel> = {
  name: 'webrtc-dc',
  capabilities: WEBRTC_DC_CAPABILITIES,
  instrument(target, sink, opts = {}) {
    return instrumentDataChannel(target, opts.peerId ?? 'unknown-webrtc-peer', sink, opts);
  },
};

export const websocketAdapter: TransportAdapter<WebSocketGlobal> = {
  name: 'websocket',
  capabilities: WEBSOCKET_CAPABILITIES,
  instrument(target, sink, opts = {}) {
    return instrumentWebSocket(target, sink, opts);
  },
};

export const hyperswarmAdapter: TransportAdapter<MinimalDuplexStream> = {
  name: 'hyperswarm',
  capabilities: HYPERSWARM_CAPABILITIES,
  instrument(target, sink, opts = {}) {
    return instrumentHyperswarmStream(target, sink, opts);
  },
};

/** Every registered transport. Adding a fourth is exactly: write the
 *  capabilities object + adapter, push one more entry here. Nothing else
 *  in this list, in `core/`, or in L0 changes. */
export const TRANSPORT_REGISTRY: TransportAdapter[] = [webrtcDataChannelAdapter, websocketAdapter, hyperswarmAdapter];
