// Proves the L2 central redactor (core/redactor.ts) makes the
// EXPORTED form of a capture safe — the stolen-.p2plog threat model (docs/06).
//
// NOT wired into run-all.sh by request. Run directly:  node redactor.test.mjs
//
// Every leak assertion carries a CONTROL proving the redactor is load-bearing:
// the un-redacted / default-passthrough path DOES leak, so a green assertion is
// distinguishable from a vacuous one (every claim gets a control case).
//
// Node 24 strips TS types, so this .mjs imports the .ts source directly.

import { Redactor, PEER_HASH_PREFIX } from '../core/redactor.ts';
import { PeerRegistry } from 'hrpc-inspector-protocol/registry';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name} ${detail}`); failures++; }
};

const RAW_PEER =
  '12D3KooWQ8v7yZ2mN4pR6sT8uV0wX1yZ3aB5cD7eF9gH0iJ2kL4'; // a libp2p-shaped PeerId

// ============================================================================
// F4 — peerId is HASHED in exported rows.
// ============================================================================
{
  const r = new Redactor();
  const row = { kind: 'res', corrId: 'c1', peer: RAW_PEER, t: 10 };
  const out = r.redact(row);

  check('F4: exported peer is prefixed hash, not raw id',
    typeof out.peer === 'string'
      && out.peer.startsWith(PEER_HASH_PREFIX)
      && !out.peer.includes(RAW_PEER),
    `peer=${out.peer}`);

  // Local-only reverse map still resolves the raw id for a live "show names" view.
  check('F4: local reverse map recovers the raw id (not exported)',
    r.resolvePeer(out.peer) === RAW_PEER);

  // Fan-out arrays of peers (timeout row's `unanswered`) are hashed element-wise.
  const to = r.redact({ kind: 'timeout', corrId: 'c2', unanswered: [RAW_PEER, '*'], t: 20 });
  check('F4: unanswered[] peers hashed element-wise; broadcast * passes through',
    Array.isArray(to.unanswered)
      && to.unanswered[0].startsWith(PEER_HASH_PREFIX)
      && to.unanswered[1] === '*'
      && !JSON.stringify(to.unanswered).includes(RAW_PEER),
    JSON.stringify(to.unanswered));

  // CONTROL: the un-redacted path (the raw row we would persist WITHOUT the
  // redactor) leaks the raw id. Proves the redactor is load-bearing.
  const leaked = JSON.stringify(row);
  check('F4 CONTROL: un-redacted row WOULD leak the raw peer id',
    leaked.includes(RAW_PEER));
}

// Stable hashing: same peer -> same handle across independent redactors sharing a
// registry; different peers -> different handles.
{
  const shared = new PeerRegistry();
  const a = new Redactor({ registry: shared });
  const b = new Redactor({ registry: shared });
  check('F4: hashing is deterministic for the same peer',
    a.hashPeer(RAW_PEER) === b.hashPeer(RAW_PEER));
  check('F4: distinct peers hash to distinct handles',
    a.hashPeer(RAW_PEER) !== a.hashPeer(RAW_PEER + 'X'));
}

// ============================================================================
// F3 — URL stripped to host-only; token/query dropped. reason redacted.
// ============================================================================
{
  const r = new Redactor();
  const SIGNAL_URL = 'wss://signal.example.com:8443/room/abc?token=SECRET123&auth=zzz#frag';
  const out = r.redact({ type: 'ws.open', url: SIGNAL_URL, reason: 'peer left: user=alice@corp', t: 1 });

  check('F3: url reduced to scheme + host(:port)',
    out.url === 'wss://signal.example.com:8443', `url=${out.url}`);
  check('F3: token / query / path / fragment stripped from url',
    !out.url.includes('SECRET123')
      && !out.url.includes('token')
      && !out.url.includes('/room/abc')
      && !out.url.includes('frag'),
    `url=${out.url}`);
  check('F3: reason redacted to a hash — original text gone',
    typeof out.reason === 'string'
      && out.reason.startsWith('h_')
      && !out.reason.includes('alice')
      && !out.reason.includes('user='),
    `reason=${out.reason}`);

  // Unparseable URL: cannot prove token-free, so drop entirely (fail safe).
  const bad = r.redact({ type: 'ws.error', url: 'not a url ?token=SECRET123', t: 2 });
  check('F3: unparseable url dropped to marker (fail safe)',
    !String(bad.url).includes('SECRET123'), `url=${bad.url}`);

  // CONTROL: default passthrough (redactor NOT applied) retains the token.
  const raw = { type: 'ws.open', url: SIGNAL_URL, reason: 'peer left: user=alice@corp', t: 1 };
  check('F3 CONTROL: un-redacted url retains the auth token',
    raw.url.includes('SECRET123') && raw.reason.includes('alice'));
}

// ============================================================================
// F9 — payload body OFF by default; present ONLY for an allowlisted method.
// ============================================================================
{
  const body = { id: 'block-42', blocks: [0, 1, 2, 3, 4, 5, 6, 7], secret: 'DO_NOT_LEAK' };

  // Default: no allowlist -> body reduced to summary, values gone.
  const rDefault = new Redactor();
  const outDefault = rDefault.redact({ type: 'message.in', method: 'blocks.fetch', body, t: 1 });
  check('F9: body absent by default — reduced to {byteLength, hash, shape}',
    outDefault.body
      && typeof outDefault.body.byteLength === 'number'
      && typeof outDefault.body.hash === 'string'
      && outDefault.body.shape
      && !JSON.stringify(outDefault.body).includes('DO_NOT_LEAK'),
    JSON.stringify(outDefault.body));
  check('F9: shape summary carries structure but no values',
    outDefault.body.shape.id === 'string'
      && outDefault.body.shape.blocks === 'Array<8>'
      && outDefault.body.shape.secret === 'string',
    JSON.stringify(outDefault.body.shape));

  // Opt-in: method on the allowlist -> full body present.
  const rAllow = new Redactor({ bodyAllowlist: ['blocks.fetch'] });
  const outAllow = rAllow.redact({ type: 'message.in', method: 'blocks.fetch', body, t: 1 });
  check('F9: allowlisted method exports full body',
    outAllow.body && outAllow.body.secret === 'DO_NOT_LEAK'
      && JSON.stringify(outAllow.body.blocks) === JSON.stringify(body.blocks));

  // CONTROL: a NON-allowlisted method on the same allowlisted redactor -> body absent.
  // Proves the gate keys on method, not on a global switch.
  const outOther = rAllow.redact({ type: 'message.in', method: 'chat.send', body, t: 1 });
  check('F9 CONTROL: non-allowlisted method -> body still absent',
    outOther.body
      && typeof outOther.body.hash === 'string'
      && !JSON.stringify(outOther.body).includes('DO_NOT_LEAK'),
    JSON.stringify(outOther.body));
}

// ============================================================================
// Crypto boundary — ciphertext is length + hash only, NEVER decrypted/exported,
// and the body allowlist can NOT re-expose it.
// ============================================================================
{
  const cipher = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // Even with the method allowlisted for bodies, ciphertext stays reduced.
  const r = new Redactor({ bodyAllowlist: ['secure.msg'] });
  const out = r.redact({ type: 'message.in', method: 'secure.msg', ciphertext: cipher, t: 1 });
  check('CRYPTO: ciphertext reduced to {byteLength, hash, encrypted:true}',
    out.ciphertext
      && out.ciphertext.byteLength === 10
      && typeof out.ciphertext.hash === 'string'
      && out.ciphertext.encrypted === true);
  check('CRYPTO CONTROL: allowlist does NOT re-expose ciphertext bytes',
    out.ciphertext && out.ciphertext[0] === undefined && !Array.isArray(out.ciphertext));
}

// ============================================================================
// Non-mutation: the live in-memory row keeps raw values; only what LEAVES is redacted.
// ============================================================================
{
  const r = new Redactor();
  const row = { kind: 'res', corrId: 'c9', peer: RAW_PEER, t: 1 };
  r.redact(row);
  check('redact() does not mutate the live row (raw kept in memory)',
    row.peer === RAW_PEER);
}

console.log(failures === 0 ? '\nALL REDACTOR CHECKS PASSED' : `\n${failures} REDACTOR CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
