// Shared build-mode guard for the L1 adapters (webrtc.ts, websocket.ts,
// hyperswarm.ts). Release-bundle hardening: probe calls are gated behind
// `__DEV__` AND meant to be stripped by a Babel plugin, because dead-code
// elimination is not guaranteed for method calls with side effects. This file
// is the `__DEV__` half. The strip half is NOT in this repo — ship a release
// build without it and the gate below is your only protection.
//
// SEMANTICS — deliberately conservative, "disable only on explicit signal":
//   - `__DEV__ === false` (RN/Metro sets this global; `false` in release
//     builds, `true` in dev, undefined everywhere else e.g. plain Node) ->
//     disabled.
//   - `process.env.NODE_ENV === 'production'` (bundlers/tooling outside RN
//     that don't define `__DEV__`) -> disabled.
//   - Anything else — including `__DEV__` and `NODE_ENV` both being
//     undefined, which is exactly this sandbox's `node verification/*.mjs`
//     runs — is treated as "assume dev, stay enabled". A probe that goes
//     inert by ABSENCE of a signal is worse than one that requires an
//     explicit signal to disable: it fails silently in exactly the
//     environments (custom bundlers, unusual test runners) an engineer is
//     least likely to think to check.
//
// This function is called at the TOP of each instrument*() entry point,
// before anything is touched on `dc`/`pc`/`stream`/the global WebSocket
// constructor — same genuine-no-op shape as the existing `enabled: false`
// path (see webrtc.ts's "DISABLED PATH" comment). Zero behavioural change
// in dev/test: verified by re-running verification/probe.test.mjs and
// verification/transport-framing.test.mjs after wiring this in — neither
// environment sets `__DEV__ = false` or `NODE_ENV = production`, so every
// existing assertion (a)-(g) in probe.test.mjs is unaffected.

// `__DEV__` is an ambient RN/Metro global. It does not exist in plain
// Node/browser environments, hence `typeof __DEV__ !== 'undefined'` below
// rather than referencing it unguarded (which would throw a
// ReferenceError under strict evaluation in environments that never
// declare it — the opposite of invariant 3: "never throw from a probe").
declare const __DEV__: boolean | undefined;

/**
 * True only when this is a build that has explicitly signalled "release":
 * `__DEV__ === false` or `NODE_ENV === 'production'`. False in every other
 * case, including when neither signal is present at all.
 *
 * Never throws (invariant 3) — a broken/instrumented `process` global (e.g.
 * a hostile shim in a test) cannot crash the probe's own build-mode check.
 */
export function isProbeDisabledByBuild(): boolean {
  try {
    if (typeof __DEV__ !== 'undefined' && __DEV__ === false) return true;
  } catch {
    /* never throw from the probe */
  }
  try {
    if (typeof process !== 'undefined' && process?.env?.NODE_ENV === 'production') return true;
  } catch {
    /* never throw from the probe */
  }
  return false;
}
