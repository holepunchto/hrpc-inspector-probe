// L2 central redactor. Applied to collector rows / L2 events as they flow toward
// EXPORT / PERSISTENCE (a .p2plog file, the Rozenite bridge, the Hyperswarm hub).
// This is the single choke point where sensitive fields are removed BEFORE they
// can be written to disk or shipped off-device — so a stolen .p2plog cannot expose
// raw peer identities, signalling tokens or message bodies.
//
// Design: redaction is CENTRAL (docs/01 R8, docs/00 §9). Adapters (L1) are NOT
// edited to redact per-transport; instead every row passes through `Redactor.redact`
// on the way out. That keeps one auditable definition of "what leaves the device".
//
// This module does NOT sign off G2. G2 is a HUMAN accountability gate
// (docs/03 §4): a named human confirms the residual risk in docs/06 before any
// capture with payload bodies or peer identities is exported. The code here makes
// the *default* safe and makes the opt-in explicit; it cannot make the human's
// decision.
//
// Crypto boundary (docs/01 R8): the inspector NEVER decrypts. Ciphertext is reduced
// to length + hash only, and the payload-body allowlist can never re-expose it.

import { PeerRegistry } from 'hrpc-inspector-protocol/registry';
// Bare has no TextEncoder, and this path runs during observe() construction.
import { utf8Encode } from 'hrpc-inspector-protocol/utf8';
import type { PeerId } from 'hrpc-inspector-protocol/envelope';

/** Marker prefix on an exported, hashed peer id. Self-describing: a reader of a
 *  .p2plog sees `ph_XXXXXXXX` and knows it is a hash, not a raw/short PeerId. */
export const PEER_HASH_PREFIX = 'ph_';
/** Marker prefix on a hashed free-text string (reason/error). */
export const TEXT_HASH_PREFIX = 'h_';

export interface ContentSummary {
  /** UTF-8 (or raw, for binary) byte length of the original body. */
  byteLength: number;
  /** FNV-1a content hash (hex). Identical bodies collide; content is unrecoverable. */
  hash: string;
  /** Structural shape only — no values. e.g. { id: 'string', blocks: 'Array<8>' }. */
  shape: unknown;
}

/** A ciphertext reduced to what we may observe without crossing the crypto boundary. */
export interface CiphertextSummary {
  byteLength: number;
  hash: string;
  /** Always true — a self-describing flag so the UI can show a "cannot decrypt" state. */
  encrypted: true;
}

export interface RedactorOptions {
  /**
   * Per-`method` opt-in allowlist for FULL payload bodies. A method NOT in this set
   * has its body reduced to a ContentSummary. This gate exists now, BEFORE body
   * capture is enabled, so the default is safe from day one (docs/00 §9, F9).
   */
  bodyAllowlist?: Iterable<string>;
  /** Field names treated as message payload bodies. Default: body, payload, data. */
  bodyFields?: Iterable<string>;
  /** Field names treated as ciphertext — NEVER exported in full, even if allowlisted. */
  ciphertextFields?: Iterable<string>;
  /** Field names carrying peer identities to hash. Default covers rows + envelopes. */
  peerFields?: Iterable<string>;
  /** Field names carrying free-text that may leak (tokens, paths). Default: reason, error. */
  textFields?: Iterable<string>;
  /** Field names carrying URLs to strip to host-only. Default: url. */
  urlFields?: Iterable<string>;
  /** Local-only reverse map for a live view. NOT exported. Injectable for sharing. */
  registry?: PeerRegistry;
  /** Max recursion depth for shape summaries. */
  maxShapeDepth?: number;
}

// Field-name driven, so this list IS the redaction boundary: 'args'/'response'/'item' are what
// wrapClient emits, and omitting them exported every RPC payload verbatim. Adding a producer?
// Add its payload key here, or it ships in the clear.
const DEFAULT_BODY_FIELDS = ['body', 'payload', 'data', 'args', 'response', 'item'];
const DEFAULT_CIPHERTEXT_FIELDS = ['ciphertext', 'cipher', 'encrypted', 'enc'];
const DEFAULT_PEER_FIELDS = ['peerId', 'peer', 'src', 'dst', 'unanswered'];
const DEFAULT_TEXT_FIELDS = ['reason', 'error'];
const DEFAULT_URL_FIELDS = ['url'];

// ---- Dependency-free FNV-1a content hash (hex). Distinct from the peer hash: the
// peer hash goes through PeerRegistry (reuse of hrpc-inspector-protocol's 6-byte scheme); this
// one summarises arbitrary body/ciphertext bytes for the "same bytes => same hash"
// diagnostic without ever retaining the bytes themselves.
function fnv1aHex(bytes: Uint8Array): string {
  let hi = 0xcbf2_9ce4 >>> 0;
  let lo = 0x8422_2325 >>> 0;
  const PRIME_LO = 0x1b3;
  for (const b of bytes) {
    lo ^= b;
    const loMul = lo * PRIME_LO;
    const hiMul = hi * PRIME_LO + lo * 0x100;
    lo = loMul >>> 0;
    const carry = Math.floor(loMul / 0x100000000);
    hi = (hiMul + carry) >>> 0;
  }
  const h = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return h(hi) + h(lo);
}

function toBytes(value: unknown): { bytes: Uint8Array; byteLength: number } {
  if (value instanceof Uint8Array) return { bytes: value, byteLength: value.byteLength };
  if (ArrayBuffer.isView(value)) {
    const v = value as ArrayBufferView;
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return { bytes, byteLength: v.byteLength };
  }
  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value);
    return { bytes, byteLength: bytes.byteLength };
  }
  const s = typeof value === 'string' ? value : stableStringify(value);
  const bytes = utf8Encode(s);
  return { bytes, byteLength: bytes.byteLength };
}

/** Deterministic stringify (sorted keys) so identical content hashes identically. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value, new Set(), 0));
}

/** Deeper than this contributes nothing readable, and an unbounded walk crashes the host app. */
const MAX_SORT_DEPTH = 32;

/**
 * NEVER-THROW: walks objects the APP owns, so a self-referencing one (`trace({ ctx: this })`)
 * must not blow the stack inside the flush timer. `seen` tracks the ancestor chain only, so a
 * value repeated in sibling positions is still walked rather than mislabelled circular.
 */
function sortDeep(v: unknown, seen: Set<object>, depth: number): unknown {
  if (typeof v === 'bigint') return `[BigInt:${v.toString()}]`; // JSON.stringify throws on these
  if (typeof v === 'function') return '[Function]';
  if (!v || typeof v !== 'object') return v;
  if (depth >= MAX_SORT_DEPTH) return '[MaxDepth]';
  const obj = v as object;
  if (seen.has(obj)) return '[Circular]';
  seen.add(obj);
  try {
    if (Array.isArray(v)) return v.map((item) => sortDeep(item, seen, depth + 1));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort())
      out[k] = sortDeep((v as Record<string, unknown>)[k], seen, depth + 1);
    return out;
  } finally {
    seen.delete(obj);
  }
}

/** Structural shape — types and array lengths only, never values. */
function summarizeShape(value: unknown, depth: number, maxDepth: number): unknown {
  if (value === null) return 'null';
  if (value instanceof Uint8Array || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    const { byteLength } = toBytes(value);
    return `bytes<${byteLength}>`;
  }
  if (Array.isArray(value)) return `Array<${value.length}>`;
  const t = typeof value;
  if (t !== 'object') return t; // 'string' | 'number' | 'boolean' | ...
  if (depth >= maxDepth) return 'object';
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>))
    out[k] = summarizeShape((value as Record<string, unknown>)[k], depth + 1, maxDepth);
  return out;
}

export class Redactor {
  readonly registry: PeerRegistry;
  private readonly bodyAllowlist: Set<string>;
  private readonly bodyFields: Set<string>;
  private readonly ciphertextFields: Set<string>;
  private readonly peerFields: Set<string>;
  private readonly textFields: Set<string>;
  private readonly urlFields: Set<string>;
  private readonly maxShapeDepth: number;

  constructor(opts: RedactorOptions = {}) {
    this.registry = opts.registry ?? new PeerRegistry();
    this.bodyAllowlist = new Set(opts.bodyAllowlist ?? []);
    this.bodyFields = new Set(opts.bodyFields ?? DEFAULT_BODY_FIELDS);
    this.ciphertextFields = new Set(opts.ciphertextFields ?? DEFAULT_CIPHERTEXT_FIELDS);
    this.peerFields = new Set(opts.peerFields ?? DEFAULT_PEER_FIELDS);
    this.textFields = new Set(opts.textFields ?? DEFAULT_TEXT_FIELDS);
    this.urlFields = new Set(opts.urlFields ?? DEFAULT_URL_FIELDS);
    this.maxShapeDepth = opts.maxShapeDepth ?? 4;
  }

  /** True if this method may export full payload bodies (opt-in, F9). */
  allowsBody(method: string | undefined): boolean {
    return method !== undefined && this.bodyAllowlist.has(method);
  }

  /**
   * Hash a single peer id into its exported form and remember the reverse mapping
   * (local-only, for a live "show names" view). Reuses hrpc-inspector-protocol's PeerRegistry
   * (6-byte FNV hash -> 8-char base32 handle). Broadcast '*' passes through.
   */
  hashPeer(peer: PeerId): string {
    if (peer === '*') return '*';
    return PEER_HASH_PREFIX + this.registry.handleFor(peer);
  }

  /** Recover a raw PeerId from an exported hash for a LOCAL live view. Never exported. */
  resolvePeer(hashed: string): PeerId {
    if (hashed === '*') return '*';
    const handle = hashed.startsWith(PEER_HASH_PREFIX)
      ? hashed.slice(PEER_HASH_PREFIX.length)
      : hashed;
    return this.registry.peerFromHandle(handle);
  }

  private hashText(text: string): string {
    return TEXT_HASH_PREFIX + fnv1aHex(utf8Encode(text));
  }

  /** Strip a URL to scheme + host(:port). Drops userinfo, path, query, fragment (F3). */
  private redactUrl(raw: string): string {
    try {
      const u = new URL(raw);
      // Deliberately omit u.username/u.password/u.pathname/u.search/u.hash.
      return `${u.protocol}//${u.host}`;
    } catch {
      // Unparseable: cannot prove it's token-free, so drop everything but the marker.
      return '[unparseable-url-redacted]';
    }
  }

  private summarizeBody(value: unknown): ContentSummary {
    const { bytes, byteLength } = toBytes(value);
    return {
      byteLength,
      hash: fnv1aHex(bytes),
      shape: summarizeShape(value, 0, this.maxShapeDepth),
    };
  }

  private summarizeCiphertext(value: unknown): CiphertextSummary {
    const { bytes, byteLength } = toBytes(value);
    return { byteLength, hash: fnv1aHex(bytes), encrypted: true };
  }

  /**
   * Redact one row/event for export. Returns a NEW shallow object; the input is not
   * mutated (the live in-memory view keeps raw values; only what LEAVES is redacted).
   */
  redact<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const method = typeof row.method === 'string' ? row.method : undefined;
    const bodyAllowed = this.allowsBody(method);

    for (const [key, value] of Object.entries(row)) {
      if (value === undefined) continue;

      // Ciphertext first — crypto boundary is absolute; allowlist cannot re-expose it.
      if (this.ciphertextFields.has(key)) {
        out[key] = this.summarizeCiphertext(value);
        continue;
      }

      if (this.peerFields.has(key)) {
        out[key] = this.redactPeerValue(value);
        continue;
      }

      if (this.urlFields.has(key) && typeof value === 'string') {
        out[key] = this.redactUrl(value);
        continue;
      }

      if (this.textFields.has(key) && typeof value === 'string') {
        out[key] = this.hashText(value);
        continue;
      }

      if (this.bodyFields.has(key)) {
        // F9: bodies OFF by default. Present in full ONLY for an allowlisted method.
        out[key] = bodyAllowed ? value : this.summarizeBody(value);
        continue;
      }

      out[key] = value;
    }
    return out;
  }

  private redactPeerValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((p) => this.redactPeerValue(p));
    if (typeof value === 'string') return this.hashPeer(value);
    return value;
  }

  /** Redact a whole flushed batch (wire this at the export/flush boundary). */
  redactBatch<T extends Record<string, unknown>>(batch: T[]): Record<string, unknown>[] {
    return batch.map((row) => this.redact(row));
  }
}
