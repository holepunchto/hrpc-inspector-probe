// UNVERIFIED — written without a compiler in this environment. Requires Xcode/Android Studio + signing to build and validate.
//
// ObjC++ registration shim. Bridges the Swift `P2PNativeProbe` class to React
// Native's TurboModule + event-emitter machinery. In the New Architecture,
// codegen generates the JSI binding from NativeP2PNativeProbe.ts; this shim
// registers the module and declares its exported surface so the Swift class is
// discoverable by name "P2PNativeProbe".
//
// UNTESTED: not compiled. Requires the app's Podfile to enable the New
// Architecture (RCT_NEW_ARCH_ENABLED=1) and a `pod install` that runs codegen.

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// The Swift class is exposed to ObjC via the generated -Swift.h header.
// Method signatures here MUST match the @objc surface in P2PNativeProbe.swift
// and the Spec in NativeP2PNativeProbe.ts.
@interface RCT_EXTERN_MODULE(P2PNativeProbe, RCTEventEmitter)

RCT_EXTERN_METHOD(start)
RCT_EXTERN_METHOD(stop)
RCT_EXTERN_METHOD(registerOutgoing:(nonnull NSNumber *)payloadHash
                  msgId:(nonnull NSString *)msgId
                  corrId:(nonnull NSString *)corrId
                  method:(nonnull NSString *)method
                  kind:(nonnull NSString *)kind
                  src:(nonnull NSString *)src
                  dst:(nonnull NSString *)dst
                  ts:(nonnull NSNumber *)ts
                  hlc:(nonnull NSString *)hlc)

// Required for the New Architecture TurboModule bridge. Returns the codegen
// spec's C++ turbo module instance. Filled in from the generated
// `NativeP2PNativeProbeSpecJSI` — left as a TODO for the toolchain step because
// the generated symbol name depends on the codegen run.
+ (BOOL)requiresMainQueueSetup { return NO; }

@end
