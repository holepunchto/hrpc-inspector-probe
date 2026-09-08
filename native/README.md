<!-- UNVERIFIED — written without a compiler in this environment. Requires Xcode/Android Studio + signing to build and validate. -->

# R6 native transport probes (UNVERIFIED)

> **Status: UNVERIFIED by construction.** Every file in this directory is source
> only. There is no iOS or Android toolchain in this sandbox — `xcodebuild`,
> `swift`, `gradle`, `kotlinc`, `adb` are all absent (verified by probing for them
> C15; only `java` is present). Nothing here has been compiled, linked, run, or
> profiled. Do not describe any of it as working, tested, or measured. On-device
> `os_signpost` / `androidx.tracing` overhead (C17) is **UNVERIFIED** and no
> number is quoted anywhere in this tree because none could be measured.

File tree:

```
native/
  README.md                         <- this file
  bridge.ts                         <- JS: NativeEventEmitter -> L2 EventSink
  ios/
    NativeP2PNativeProbe.ts         <- TurboModule TS spec (codegen input, shared by both platforms)
    P2PNativeProbe.swift            <- MCSessionDelegate tap + os_signpost + emit
    P2PNativeProbe.mm               <- ObjC++ RCT registration shim
  android/
    P2PNativeProbeModule.kt         <- Nearby PayloadCallback/lifecycle tap + androidx.tracing + emit
    P2PNativeProbePackage.kt        <- ReactPackage registration
```

## (a) Event shape MUST match the frozen JS L2 schema

Native events are **not** a parallel schema. They are the *same* L2 events the JS
adapters emit, produced from native code (invariant 1: uniformity is what lets
one panel render both). The panel and the L2 collector must not need to know
whether an event came from JS or native.

Source of truth for field names (do not edit to match native — edit native to
match these):

- `src/sink.ts` — `L2Event` interface, `L2EventType` union.
- `hrpc-inspector-protocol/envelope.ts` — `P2PEnvelope` frozen wire fields.

Exact fields the native side populates (byte-identical keys, both platforms):

| field       | source of value on native side                                  | JS/L0 origin                     |
|-------------|-----------------------------------------------------------------|----------------------------------|
| `type`      | one of the `L2EventType` strings (`message.out`, `message.in`, `conn.state`) | sink.ts `L2EventType` |
| `t`         | monotonic ms (`mach_absolute_time` iOS / `System.nanoTime()` Android) | sink.ts `L2Event.t`        |
| `transport` | constant `"multipeer"` (iOS) / `"nearby"` (Android)             | sink.ts `L2Event.transport`      |
| `bytes`     | payload byte length                                             | envelope-adjacent, sink `bytes`  |
| `peerId`    | spine field: remote endpoint display name / id                 | sink.ts `L2Event.peerId`         |
| `msgId`     | supplied via `registerOutgoing` (outbound only)                | envelope.ts `msgId` (ULID)       |
| `corrId`    | supplied via `registerOutgoing`                                | envelope.ts `corrId`             |
| `method`    | supplied via `registerOutgoing`                                | envelope.ts `method`             |
| `kind`      | supplied via `registerOutgoing` (`req`/`res`/`event`/`ack`/`err`) | envelope.ts `Kind`            |
| `src`       | supplied via `registerOutgoing` (out) / remote id (in)         | envelope.ts `src`                |
| `dst`       | supplied via `registerOutgoing`                                | envelope.ts `dst`                |
| `ts`        | supplied via `registerOutgoing` (sender wall clock, epoch ms)  | envelope.ts `ts` (untrusted)     |
| `hlc`       | supplied via `registerOutgoing` (`"phys:ctr:node"`)            | envelope.ts `hlc`                |

Rationale for the `registerOutgoing` correlation channel: the native transport
layer sees raw `Data`/`Payload` bytes. It **must not** decode the envelope — that
would duplicate `hrpc-inspector-protocol` and drift. So the app hands the native side the
identifiers (`msgId`/`corrId`/`method`/`kind`/`src`/`dst`/`ts`/`hlc`) keyed by a
payload hash *just before* sending; the native `message.out` tap attaches them.
For `message.in`, native emits only transport-level facts (`bytes`, `src`, `t`,
`peerId`); L2's correlator stitches `msgId`/`corrId` downstream by decoding the
payload — exactly as the JS `message.in` path does. This keeps decoding in one
place (L0) and keeps native/JS event shapes identical.

**Parity check to run once a build exists:** capture one native event and one JS
event of the same `type` and assert their key sets are equal (see checklist).

## (b) How the TurboModule event emitter bridges to the JS collector

- **TS spec:** `ios/NativeP2PNativeProbe.ts` declares a `TurboModule` (invariant
  2: JSI, not the legacy bridge). RN codegen turns it into the iOS spec protocol
  and the Android abstract spec.
- **iOS emit:** `P2PNativeProbe.swift` holds the event-emitter callback and emits
  under the single event name `"p2p.l2.event"`. The ObjC++ shim
  (`P2PNativeProbe.mm`) registers the module as an `RCTEventEmitter` subclass.
- **Android emit:** `P2PNativeProbeModule.kt` emits via
  `RCTDeviceEventEmitter.emit("p2p.l2.event", writableMap)`.
- **JS side:** `native/bridge.ts` — `instrumentNativeTransport(sink)` opens a
  `NativeEventEmitter`, subscribes to `"p2p.l2.event"`, and routes each payload
  straight into the same `EventSink.emit()` the JS adapters use, via `emitSafe`
  (a native payload must never crash the app). Call it once at app entry next to
  `instrumentWebSocket` / `instrumentWebRTC`. If the native module is not linked
  (e.g. web target) it is a genuine no-op, mirroring `{ enabled: false }`.

Both native sides mirror the JS `emitSafe` guarantee: the emit path swallows all
throwables so the monitoring layer can never crash the transport it observes.

## (c) Exact toolchain + signing needed to actually build/verify (the R6 gate)

None of the following can be done in this sandbox. This is the handoff list for
whoever has a real machine.

**iOS**

- macOS with Xcode (Command Line Tools: `xcodebuild`, `swiftc`).
- CocoaPods; app Podfile with New Architecture enabled: `RCT_NEW_ARCH_ENABLED=1`.
- `Info.plist`: `NSLocalNetworkUsageDescription` and `NSBonjourServices`
  (MultipeerConnectivity requires local-network permission).
- A signing identity: Apple Developer Program membership, a Development
  provisioning profile, and a code-signing certificate — MultipeerConnectivity
  peer discovery does **not** work on Simulator's shared network the way a real
  device does, so a signed device build is required to exercise it.
- Instruments.app to view the `os_signpost` intervals (subsystem
  `io.tether.p2p.probe`, category `transport`, names `mc.send` / `mc.recv`).

**Android**

- Android Studio / Android SDK + NDK; Gradle; Kotlin.
- `gradle.properties`: `newArchEnabled=true`.
- Google Play services (Nearby Connections lives in
  `com.google.android.gms:play-services-nearby`); add the dependency to the app
  module `build.gradle`.
- `androidx.tracing:tracing` dependency for the `Trace.beginSection` sections.
- Manifest permissions for Nearby: `BLUETOOTH_*`, `ACCESS_WIFI_STATE`,
  `ACCESS_FINE_LOCATION` / `NEARBY_WIFI_DEVICES` (API-level dependent).
- A debug (or release) keystore to sign the APK; a physical device with Play
  services (Nearby needs real radios — emulator will not discover peers).
- Perfetto / `systrace` to view the `nearby.send` / `nearby.recv` sections.

## Build-and-verify checklist (all UNVERIFIED here — run on a real toolchain)

1. **Compile iOS.** `cd ios && pod install` (runs codegen), then
   `xcodebuild -workspace App.xcworkspace -scheme App -destination 'generic/platform=iOS' build`.
   - Expected: build succeeds; `NativeP2PNativeProbeSpec` generated under
     `build/generated/ios`.
   - Failure signals: "cannot find type 'NativeP2PNativeProbeSpec'" (codegen did
     not run → check `RCT_NEW_ARCH_ENABLED`); "no such module
     'MultipeerConnectivity'" (framework not linked).
2. **Compile Android.** `./gradlew :app:assembleDebug`.
   - Expected: build succeeds; codegen produces the abstract spec.
   - Failure signals: unresolved `com.google.android.gms.nearby.*` (Play services
     dep missing); unresolved `androidx.tracing.Trace` (tracing dep missing).
3. **Wire the TurboModule.** Register `P2PNativeProbePackage` (Android) / confirm
   autolink (iOS), call `instrumentNativeTransport(sink)` at app entry, and have
   the app route its `MCSession.send` / Nearby `sendPayload` through the tap and
   call `registerOutgoing(...)` immediately before each send.
   - Expected: JS receives `"p2p.l2.event"` payloads; they land in the L2 ring
     buffer.
   - Failure signals: no events in JS (emitter name mismatch, or `start()` not
     called); events missing `msgId`/`corrId` (app did not call
     `registerOutgoing`, or payload-hash keys did not match).
4. **Confirm event-shape parity.** Capture one native `message.out` and one JS
   `message.out`; assert equal key sets and same `transport`/`type` typing.
   - Expected: identical key sets for the shared fields in the table above.
   - Failure signal: any key present on one side and not the other → fix the
     native field name to match sink.ts / envelope.ts (never the reverse).
5. **Measure native-layer overhead (C17).** In Instruments (iOS) confirm the
   `mc.send`/`mc.recv` signpost intervals appear; in Perfetto (Android) confirm
   the `nearby.send`/`nearby.recv` sections appear; then measure the added cost
   with the probe enabled vs a control build with it disabled.
   - Expected: a real, measured delta from a control comparison.
   - **This number does not exist yet and MUST NOT be guessed.** C17 stays
     UNVERIFIED until this step runs on a device.
