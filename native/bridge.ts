// UNVERIFIED — written without a compiler in this environment. Requires Xcode/Android Studio + signing to build and validate.
//
// JS-side bridge: subscribes to the native TurboModule event emitter and routes
// every native transport event straight into the SAME L2 EventSink the JS
// adapters use (src/sink.ts). This is the seam that lets one
// panel render native + JS events uniformly (invariant 1).
//
// UNTESTED end-to-end: the native module cannot be built here, so this file has
// never received a real native event. Its TYPES compile under the JS toolchain,
// but the runtime path (NativeEventEmitter delivering a native payload) is
// UNVERIFIED until iOS/Android builds exist.

import { NativeEventEmitter, NativeModules } from 'react-native';
import type { EventSink, L2Event } from '../src/sink.ts';
import { emitSafe } from '../src/sink.ts';

// The single event name both native sides emit under (iOS jsEventName /
// Android EVENT_NAME). Keep in lockstep with the native constants.
const NATIVE_EVENT_NAME = 'p2p.l2.event';
const MODULE_NAME = 'P2PNativeProbe';

export interface NativeProbeHandle {
  stop(): void;
}

/**
 * Attach the native transport probe to a JS L2 sink. Call once at app entry,
 * alongside instrumentWebSocket / instrumentWebRTC.
 *
 * The native side is trusted to emit objects that ALREADY match the L2Event
 * shape (see native/README.md (a)). We do a minimal defensive coercion of the
 * two spine fields (`type`, `t`) and pass the rest through untouched so that
 * adding a native field never requires a JS change (invariant 1 / mechanical
 * wiring).
 */
export function instrumentNativeTransport(sink: EventSink): NativeProbeHandle {
  const nativeModule = NativeModules[MODULE_NAME] as
    | { start(): void; stop(): void }
    | undefined;

  if (!nativeModule) {
    // No native module linked (e.g. running in a plain JS/web target). Genuine
    // no-op — mirrors instrumentWebSocket({ enabled: false }).
    return { stop() {} };
  }

  const emitter = new NativeEventEmitter(nativeModule as unknown as never);
  const subscription = emitter.addListener(NATIVE_EVENT_NAME, (raw: unknown) => {
    const evt = raw as Partial<L2Event> | null | undefined;
    if (!evt || typeof evt.type !== 'string' || typeof evt.t !== 'number') {
      // Malformed native payload — drop rather than corrupt the timeline.
      return;
    }
    // Route through emitSafe: a native payload must never crash the app.
    emitSafe(sink, evt as L2Event);
  });

  nativeModule.start();

  return {
    stop() {
      try {
        nativeModule.stop();
      } finally {
        subscription.remove();
      }
    },
  };
}
