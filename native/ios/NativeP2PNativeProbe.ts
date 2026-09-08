// UNVERIFIED — written without a compiler in this environment. Requires Xcode/Android Studio + signing to build and validate.
//
// TurboModule TypeScript spec. React Native codegen consumes THIS file to
// generate the native spec protocol (iOS: NativeP2PNativeProbeSpec ObjC/Swift
// protocol; Android: the JNI stubs). The Swift/Kotlin implementations conform
// to what codegen emits from here.
//
// INVARIANT 2: this is a TurboModule (`TurboModuleRegistry`), so
// the JS<->native path is JSI, not the legacy async bridge.
//
// UNTESTED: codegen has NOT been run. `react-native codegen` (or a pod install /
// gradle build that triggers it) must be executed on a real toolchain.

import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  // Start/stop the native transport tap. Idempotent.
  start(): void;
  stop(): void;

  // Register outbound correlation metadata immediately before the app calls
  // MCSession.send / Nearby.sendPayload, so native "message.out" events carry
  // the SAME msgId/corrId/method/kind/src/dst/ts/hlc as the JS envelope.
  // `payloadHash` is a stable hash the app computes over the outgoing bytes;
  // the native side matches the subsequent send by it. All fields are the
  // frozen L0/L2 field names.
  registerOutgoing(
    payloadHash: number,
    msgId: string,
    corrId: string,
    method: string,
    kind: string,
    src: string,
    dst: string,
    ts: number,
    hlc: string,
  ): void;

  // NativeEventEmitter plumbing. The JS collector subscribes to the single
  // event name "p2p.l2.event"; each payload is a ready-to-emit L2Event.
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('P2PNativeProbe');
