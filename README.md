# hrpc-inspector-probe

L1 transport taps and the L2 collector behind [`hrpc-inspector`](https://github.com/holepunchto/hrpc-inspector).
Separated so a tap can be wired without pulling in the CLI or the GUI.

```
npm i hrpc-inspector-probe
```

## Layout

| Directory | Contents |
| --- | --- |
| `adapters/` | L1 taps: WebRTC `DataChannel`/`PeerConnection`, the global `WebSocket` constructor, a NoiseSecretStream-shaped duplex |
| `core/` | L2: ring buffer, correlator, sampler, batch flusher, ingestion sink, central redactor |
| `clock/` | hybrid logical clock plus offset/skew estimation for the multi-peer timeline |
| `transport/` | length-prefixed framing and the per-transport capability contract |
| `exporters/` | the Hyperswarm egress path |
| `src/sink.ts` | the `EventSink` / `L2Event` seam every adapter emits through |
| `native/` | iOS/Android probe bridge — **source only, never compiled** (see `native/README.md`) |

## Two invariants worth knowing before you edit

**Never throw into the host app.** Every adapter emits through `emitSafe`, and `BatchFlusher.flushNow`
runs from a `setInterval`, so an exception there would be uncatchable by the app being observed. On
failure the batch is dropped and counted — never passed on, because `onFlush` is where redaction
happens and continuing past a failure would export an unredacted batch.

**The taps observe; they do not rewrite.** `instrumentHyperswarmStream` is passthrough in both
directions. An earlier version length-prefixed the application's own outbound payload, which
corrupted every message for any app not already speaking that framing. Framing belongs solely on
the observability channel.

## Test

```
npm test
```

Nine dependency-free suites. Every claim carries a control that fails if the fix is reverted.

## License

[Apache-2.0](LICENSE). Copyright notice in [NOTICE](NOTICE).
