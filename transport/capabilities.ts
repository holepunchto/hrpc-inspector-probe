// Transport capability descriptor — the generalization seam.
//
// WHY THIS EXISTS: hrpc-inspector-protocol's identity-drop guard (hrpc-inspector-protocol/
// src/identity.ts, finding C20) is keyed off a closed `Transport` union
// ('libp2p' | 'webrtc-dc' | 'raw-tcp' | 'raw-udp') that is frozen L0 wire
// contract. Adding Hyperswarm (or any future transport) should NOT require
// widening that union or touching L0 — that would mean `core/` (and the L0
// package everything else builds against) changes every time L1 grows a
// transport, which violates the layering promise that
// "only L1 and L4 are platform-specific."
//
// So: every adapter DESCRIBES itself with a `TransportCapabilities` value.
// L2 (or, as proven in verification/transport-framing.test.mjs, a capability-
// driven predicate living alongside this file) decides identity-drop
// eligibility from the DESCRIPTOR, not from a hardcoded transport name. A new
// transport is then just a new capabilities object + adapter — zero edits to
// L0 or to any existing adapter.

export type Orientation = 'message' | 'stream';

export interface TransportCapabilities {
  /** 'message': send()/onmessage() give you discrete envelopes for free (WebRTC-DC, WebSocket).
   *  'stream': raw byte stream with no message boundaries (Hyperswarm NoiseSecretStream, TCP) —
   *  requires the framing normalizer (./framing.ts) before envelopes can be recovered. */
  orientation: Orientation;
  /** Delivery is guaranteed (no silent drops at the transport layer). */
  reliable: boolean;
  /** Delivery preserves send order. */
  ordered: boolean;
  /** One physical channel multiplexes multiple logical peers/streams (e.g. a
   *  yamux-muxed libp2p connection). Multiplexed channels can NEVER have
   *  identity dropped — the channel no longer identifies a single src/dst. */
  multiplexed: boolean;
  /** The channel's own cryptographic handshake already proves peer identity
   *  (e.g. Hyperswarm's Noise handshake -> `remotePublicKey`, libp2p's peer
   *  ID). When true, identity-drop has a free, tamper-evident channel->peer
   *  map to recover src/dst from — no separate out-of-band bookkeeping. */
  intrinsicIdentity: boolean;
}

export const WEBRTC_DC_CAPABILITIES: TransportCapabilities = {
  orientation: 'message',
  reliable: true,
  ordered: true,
  multiplexed: false,
  intrinsicIdentity: false, // WebRTC DC identity comes from the signalling layer, not the channel itself
};

export const WEBSOCKET_CAPABILITIES: TransportCapabilities = {
  orientation: 'message',
  reliable: true,
  ordered: true,
  multiplexed: false,
  intrinsicIdentity: false,
};

/**
 * Hyperswarm / Holepunch NoiseSecretStream. STREAM-oriented (no message
 * boundaries — requires ./framing.ts), reliable+ordered (UDX underneath,
 * comparable to TCP), NOT multiplexed (one NoiseSecretStream == one remote
 * peer connection; Hyperswarm opens a new stream per peer rather than
 * multiplexing many peers over one), and INTRINSIC identity: the Noise
 * handshake authenticates `remotePublicKey` before a byte of application data
 * ever moves, so identity-drop can recover src/dst from the stream itself
 * with no fragile side-channel map.
 */
export const HYPERSWARM_CAPABILITIES: TransportCapabilities = {
  orientation: 'stream',
  reliable: true,
  ordered: true,
  multiplexed: false,
  intrinsicIdentity: true,
};

export type IdentityTopology = 'unicast-1to1' | 'multiplexed' | 'relayed' | 'fanout';

export interface IdentityDropDescriptor {
  capabilities: TransportCapabilities;
  topology: IdentityTopology;
}

/**
 * Capability-driven identity-drop predicate. This is deliberately a SUBSET of
 * hrpc-inspector-protocol's `checkIdentityDrop` (identity.ts) rule set — it covers the
 * general "one channel == one peer, not multiplexed" rule that applies to
 * ANY transport uniformly. It does NOT encode transport-specific carve-outs
 * like raw-udp's NAT-rebind refusal (identity.ts owns that; capabilities as
 * specified here — orientation/reliable/ordered/multiplexed/intrinsicIdentity
 * — have no field for "connectionless", so that refusal correctly stays in
 * L0, transport-keyed). The two are complementary, not duplicative: this
 * predicate is what a NEW transport gets automatically for free; identity.ts
 * remains the authority for known, transport-specific exceptions.
 */
export function capabilitiesAllowIdentityDrop(d: IdentityDropDescriptor): boolean {
  if (d.topology !== 'unicast-1to1') return false;
  if (d.capabilities.multiplexed) return false;
  return true;
}
