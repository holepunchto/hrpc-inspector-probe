// UNVERIFIED — written without a compiler in this environment. Requires Xcode/Android Studio + signing to build and validate.
//
// ReactPackage registration for the Android native probe. Add this to the
// host app's getPackages() (or rely on autolinking once this is published as an
// RN module with a react-native.config.js). UNTESTED: not compiled.

package io.tether.p2p.probe

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class P2PNativeProbePackage : ReactPackage {
    override fun createNativeModules(
        reactContext: ReactApplicationContext,
    ): List<NativeModule> = listOf(P2PNativeProbeModule(reactContext))

    override fun createViewManagers(
        reactContext: ReactApplicationContext,
    ): List<ViewManager<*, *>> = emptyList()
}
