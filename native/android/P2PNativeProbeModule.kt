// UNVERIFIED — written without a compiler in this environment. Requires Xcode/Android Studio + signing to build and validate.
//
// Android native transport probe (R6). Taps Google Nearby Connections'
// PayloadCallback (receive) and the app's sendPayload path (send), emits
// androidx.tracing sections for native-layer latency into Perfetto, and
// forwards L2-schema events into the JS collector via the TurboModule event
// emitter.
//
// This is KOTLIN SOURCE ONLY. It has NOT been compiled, run, or profiled.
// There is no Android toolchain here (gradle/kotlinc absent per docs/02 C15).
// Field names are copied byte-for-byte from the frozen JS schema
// (src/sink.ts) and the L0 envelope
// (hrpc-inspector-protocol/envelope.ts) so wiring is mechanical, not a
// redesign.

package io.tether.p2p.probe

import androidx.tracing.Trace
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import java.util.concurrent.ConcurrentHashMap

/**
 * The New Architecture (TurboModule) module. On a real toolchain this class
 * extends the codegen-generated `NativeP2PNativeProbeSpec` (from
 * native/ios/NativeP2PNativeProbe.ts, shared TS spec). We extend
 * ReactContextBaseJavaModule here and leave the spec `abstract` conformance to
 * the codegen step (see README). INVARIANT 2: the New Architecture path is JSI,
 * not the legacy async bridge — enable newArchEnabled=true in gradle.properties.
 *
 * UNTESTED: not compiled, codegen not run.
 */
class P2PNativeProbeModule(
    private val reactCtx: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactCtx) {

    override fun getName(): String = NAME

    // Outbound correlation metadata, keyed by a payload hash the app supplies,
    // so native "message.out" events carry the SAME identifiers as the JS
    // envelope. Cleared on match.
    private val pendingMeta = ConcurrentHashMap<Long, OutgoingMeta>()

    data class OutgoingMeta(
        val msgId: String,
        val corrId: String,
        val method: String,
        val kind: String,   // req|res|event|ack|err
        val src: String,
        val dst: String,
        val ts: Double,      // sender wall clock epoch ms
        val hlc: String,
    )

    @ReactMethod
    fun start() { /* Tap installed by wrapping the app's callbacks — see below. */ }

    @ReactMethod
    fun stop() { pendingMeta.clear() }

    @ReactMethod
    fun registerOutgoing(
        payloadHash: Double,
        msgId: String,
        corrId: String,
        method: String,
        kind: String,
        src: String,
        dst: String,
        ts: Double,
        hlc: String,
    ) {
        pendingMeta[payloadHash.toLong()] = OutgoingMeta(msgId, corrId, method, kind, src, dst, ts, hlc)
    }

    // NativeEventEmitter contract (New Arch requires these to exist).
    @ReactMethod fun addListener(eventName: String) { /* no-op; JSI-managed */ }
    @ReactMethod fun removeListeners(count: Double) { /* no-op; JSI-managed */ }

    // ---- Emit path: the ONLY way events leave native ----
    // Mirrors emitSafe() on JS — must never throw into the transport thread.
    internal fun emitL2(event: WritableMap) {
        try {
            reactCtx
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(JS_EVENT_NAME, event)
        } catch (_: Throwable) {
            // A monitoring layer must not crash the app it monitors.
        }
    }

    // ---- Monotonic clock: mirror JS performance.now() (monotonic ms) ----
    private fun monotonicMillis(): Double = System.nanoTime() / 1_000_000.0

    // ---- Outbound tap ----
    // Call from the app's sendPayload wrapper, around
    // Nearby.getConnectionsClient(ctx).sendPayload(endpointId, payload).
    fun tapSend(endpointId: String, payload: Payload) {
        val sizeBytes = payload.asBytes()?.size ?: 0
        Trace.beginSection("nearby.send")
        try {
            val meta = payload.id.let { pendingMeta.remove(it) }
            val event = Arguments.createMap().apply {
                putString(F_TYPE, "message.out")
                putDouble(F_T, monotonicMillis())
                putString(F_TRANSPORT, TRANSPORT)
                putInt(F_BYTES, sizeBytes)
                putString(F_PEER_ID, endpointId)
                if (meta != null) {
                    putString(F_MSG_ID, meta.msgId)
                    putString(F_CORR_ID, meta.corrId)
                    putString(F_METHOD, meta.method)
                    putString(F_KIND, meta.kind)
                    putString(F_SRC, meta.src)
                    putString(F_DST, meta.dst)
                    putDouble(F_TS, meta.ts)
                    putString(F_HLC, meta.hlc)
                }
            }
            emitL2(event)
        } finally {
            Trace.endSection()
        }
    }

    // ---- The PayloadCallback / ConnectionLifecycleCallback taps ----
    // The app installs THESE instead of its bare callbacks; each forwards to the
    // app's real callback after tapping (decorator — behaviour unchanged).

    fun wrapPayloadCallback(delegate: PayloadCallback): PayloadCallback =
        object : PayloadCallback() {
            override fun onPayloadReceived(endpointId: String, payload: Payload) {
                Trace.beginSection("nearby.recv")
                try {
                    val sizeBytes = payload.asBytes()?.size ?: 0
                    // Do NOT decode the envelope here (L0's job — avoid
                    // duplicating hrpc-inspector-protocol). Emit transport-level facts;
                    // L2's correlator stitches msgId/corrId downstream, exactly
                    // as the JS message.in path does.
                    val event = Arguments.createMap().apply {
                        putString(F_TYPE, "message.in")
                        putDouble(F_T, monotonicMillis())
                        putString(F_TRANSPORT, TRANSPORT)
                        putInt(F_BYTES, sizeBytes)
                        putString(F_SRC, endpointId)
                        putString(F_PEER_ID, endpointId)
                    }
                    emitL2(event)
                } finally {
                    Trace.endSection()
                }
                delegate.onPayloadReceived(endpointId, payload)
            }

            override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
                delegate.onPayloadTransferUpdate(endpointId, update)
            }
        }

    fun wrapConnectionLifecycle(delegate: ConnectionLifecycleCallback): ConnectionLifecycleCallback =
        object : ConnectionLifecycleCallback() {
            override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
                emitConnState(endpointId, "connecting")
                delegate.onConnectionInitiated(endpointId, info)
            }

            override fun onConnectionResult(endpointId: String, resolution: ConnectionResolution) {
                val ok = resolution.status.isSuccess
                emitConnState(endpointId, if (ok) "connected" else "notConnected")
                delegate.onConnectionResult(endpointId, resolution)
            }

            override fun onDisconnected(endpointId: String) {
                emitConnState(endpointId, "notConnected")
                delegate.onDisconnected(endpointId)
            }
        }

    private fun emitConnState(endpointId: String, state: String) {
        val event = Arguments.createMap().apply {
            putString(F_TYPE, "conn.state")
            putDouble(F_T, monotonicMillis())
            putString(F_TRANSPORT, TRANSPORT)
            putString(F_PEER_ID, endpointId)
            putString("conn", state)
        }
        emitL2(event)
    }

    companion object {
        const val NAME = "P2PNativeProbe"
        const val JS_EVENT_NAME = "p2p.l2.event"
        const val TRANSPORT = "nearby"

        // FROZEN L2/L0 field names — must match src/sink.ts
        // and hrpc-inspector-protocol/envelope.ts byte-for-byte.
        const val F_TYPE = "type"
        const val F_T = "t"
        const val F_MSG_ID = "msgId"
        const val F_CORR_ID = "corrId"
        const val F_METHOD = "method"
        const val F_KIND = "kind"
        const val F_SRC = "src"
        const val F_DST = "dst"
        const val F_TS = "ts"
        const val F_HLC = "hlc"
        const val F_BYTES = "bytes"
        const val F_TRANSPORT = "transport"
        const val F_PEER_ID = "peerId"
    }
}
