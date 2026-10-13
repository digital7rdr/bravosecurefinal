package com.bravosecure.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.util.UUID

/**
 * "Share to Bravo" (2026-10-13) — Bravo as an Android share target.
 *
 * Another app (Gallery, the screenshot preview, Files, a browser) sends
 * ACTION_SEND / ACTION_SEND_MULTIPLE to MainActivity (intent filters in the
 * manifest overlay). MainActivity hands the intent to [capture], which keeps it
 * until JS asks for it with [getPending], and pings JS with the
 * "BravoShareIntent" event when the app is already running.
 *
 * The shared items arrive as content:// URIs whose read grant belongs to this
 * activity launch and can lapse, so [getPending] COPIES each one into the app's
 * private cache (cacheDir/share-in/) and hands JS plain file:// paths. The JS
 * side treats those copies as ephemeral: the chat's media pipeline encrypts the
 * bytes and deletes the plaintext copy, and [discardFiles] removes anything
 * left by a cancelled share.
 *
 * Limits: 10 items, 100 MB each (the chat pipeline enforces its own, lower,
 * attachment cap with a clear message).
 *
 * getName() MUST be "BravoShareIntent" — NativeModules.BravoShareIntent in
 * src/modules/messenger/share/incomingShare.ts.
 */
class BravoShareIntentModule(private val reactCtx: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactCtx) {

  override fun getName(): String = "BravoShareIntent"

  /** Resolves `{text, subject, items: [{uri, mimeType, name, size}]}` or null. */
  @ReactMethod
  fun getPending(promise: Promise) {
    val intent = synchronized(lock) { pending }
    if (intent == null) { promise.resolve(null); return }
    Thread {
      try {
        promise.resolve(read(intent))
      } catch (t: Throwable) {
        promise.reject("share_read_failed", t.message ?: "share_read_failed")
      }
    }.start()
  }

  /** Forget the pending share (its copies stay for the chat to send). */
  @ReactMethod
  fun clear(promise: Promise) {
    synchronized(lock) { pending = null }
    promise.resolve(null)
  }

  /** Delete every copy left in the share cache (a cancelled share). */
  @ReactMethod
  fun discardFiles(promise: Promise) {
    try { File(reactCtx.cacheDir, DIR).listFiles()?.forEach { it.delete() } } catch (_: Throwable) {}
    promise.resolve(null)
  }

  // Required by NativeEventEmitter on the JS side.
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}

  private fun read(intent: Intent): com.facebook.react.bridge.WritableMap {
    val out = Arguments.createMap()
    out.putString("text", intent.getStringExtra(Intent.EXTRA_TEXT))
    out.putString("subject", intent.getStringExtra(Intent.EXTRA_SUBJECT))
    val items = Arguments.createArray()
    val dir = File(reactCtx.cacheDir, DIR).apply { mkdirs() }
    for (uri in streams(intent).take(MAX_ITEMS)) {
      try {
        val cr = reactCtx.contentResolver
        val mime = cr.getType(uri) ?: intent.type ?: "application/octet-stream"
        var name: String? = null
        var size = -1L
        cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
          if (c.moveToFirst()) {
            val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            val si = c.getColumnIndex(OpenableColumns.SIZE)
            if (ni >= 0) name = c.getString(ni)
            if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
          }
        }
        if (size > MAX_BYTES) continue
        val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)
        val target = File(dir, UUID.randomUUID().toString() + if (ext != null) ".$ext" else "")
        var copied = 0L
        cr.openInputStream(uri)?.use { input ->
          target.outputStream().use { output ->
            val buf = ByteArray(64 * 1024)
            while (true) {
              val n = input.read(buf)
              if (n < 0) break
              copied += n
              if (copied > MAX_BYTES) throw IllegalStateException("too_large")
              output.write(buf, 0, n)
            }
          }
        } ?: continue
        val item = Arguments.createMap()
        item.putString("uri", Uri.fromFile(target).toString())
        item.putString("mimeType", mime)
        item.putString("name", name ?: target.name)
        item.putDouble("size", copied.toDouble())
        items.pushMap(item)
      } catch (_: Throwable) {
        // One unreadable or oversized item must not lose the rest.
      }
    }
    out.putArray("items", items)
    return out
  }

  @Suppress("DEPRECATION")
  private fun streams(intent: Intent): List<Uri> = when (intent.action) {
    Intent.ACTION_SEND -> listOfNotNull(
      if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
      else intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM),
    )
    Intent.ACTION_SEND_MULTIPLE ->
      (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
       else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)) ?: emptyList()
    else -> emptyList()
  }
    // content:// only, and never one of Bravo's OWN providers: a hostile app
    // could otherwise "share" a file:// or provider URI that points into
    // Bravo's private storage (the encrypted message database, keys) and get
    // it sent to a chat.
    .filter { it.scheme == "content" }
    .filterNot { (it.authority ?: "").startsWith(reactCtx.packageName) }

  companion object {
    private const val DIR = "share-in"
    private const val MAX_ITEMS = 10
    private const val MAX_BYTES = 100L * 1024 * 1024
    private val lock = Any()
    private var pending: Intent? = null

    /**
     * Called by MainActivity for every launch / new intent. Keeps share
     * intents only, and tells a running JS app that one arrived.
     */
    fun capture(activity: Activity, intent: Intent?) {
      if (intent == null) return
      if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return
      synchronized(lock) { pending = Intent(intent) }
      try {
        val app = activity.application as? com.facebook.react.ReactApplication ?: return
        val ctx = app.reactHost?.currentReactContext ?: return
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit("BravoShareIntent", null)
      } catch (_: Throwable) {
        // JS not up yet: it reads getPending() on start.
      }
    }
  }
}
