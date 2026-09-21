package com.bravosecure.app

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

/**
 * B-776 — JS <-> native bridge for the receive-side priority hold.
 * getName() MUST be "BravoMessageSync": NativeModules.BravoMessageSync in
 * src/modules/messenger/push/receiveForegroundHold.ts.
 *
 * Two lanes (rev5), tried in order on every API level:
 *  1. The dataSync FOREGROUND SERVICE (MessageSyncForegroundService) on a
 *     SILENCED channel — full foreground scheduling, no card. Measured on the
 *     HyperOS Redmi: 0.7–1.8 s per background receive.
 *  2. If the OS refuses the service (Android 12+ background start with no
 *     exemption / push window), the service itself schedules the EXPEDITED
 *     JOB (MessageSyncJobService): weaker on HyperOS (~2.5 s, the process
 *     stays in cpuset:/background) but never refused for a temp-allowlisted
 *     app and never draws anything.
 *
 * Both methods are fire-and-forget (JS does not await) and never throw into
 * JS: a refused hold must never break a receive.
 *
 * Truth lives natively (critic F1): JS calls start() on EVERY hold, and this
 * module decides — a live hold only gets its watchdog re-armed (never a
 * re-schedule or a notification re-post), a finished or refused one is
 * (re)started. A refusal earlier in the process therefore never blocks a
 * later start that would succeed.
 *
 * Grace: `stop()` is applied after a short delay on the main looper and a
 * `start()` inside that window cancels it, so a burst of envelopes (the
 * relay's flush-on-connect, the sealed-archive replay) does not flap the
 * hold. The delay lives here, not in JS, because RN pauses JS timers for a
 * backgrounded process.
 */
class BravoMessageSyncModule(private val reactCtx: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactCtx) {
  private val handler = Handler(Looper.getMainLooper())
  private var pendingStop: Runnable? = null

  override fun getName(): String = "BravoMessageSync"

  @ReactMethod
  fun start(opts: ReadableMap?) {
    val body = if (opts != null && opts.hasKey("body")) opts.getString("body") else null
    val maxMs = if (opts != null && opts.hasKey("maxMs")) opts.getDouble("maxMs").toLong()
      else MessageSyncForegroundService.DEFAULT_MAX_MS
    handler.post {
      pendingStop?.let {
        handler.removeCallbacks(it)
        pendingStop = null
      }
      // A live job (the refusal fallback) only needs a re-arm; otherwise try
      // the service first — it falls back to the job by itself when refused.
      val liveJob = MessageSyncJobService.instance
      if (MessageSyncJobService.running && liveJob != null) {
        liveJob.rearm(maxMs)
        return@post
      }
      startForegroundService(body, maxMs)
    }
  }

  @ReactMethod
  fun stop() {
    handler.post {
      pendingStop?.let { handler.removeCallbacks(it) }
      val r = Runnable {
        pendingStop = null
        stopForegroundService()
        MessageSyncJobService.finishOrCancel(reactCtx)
      }
      pendingStop = r
      handler.postDelayed(r, STOP_GRACE_MS)
    }
  }

  // ── The dataSync foreground service (falls back to the job when refused) ──

  private fun startForegroundService(body: String?, maxMs: Long) {
    val live = MessageSyncForegroundService.instance
    if (MessageSyncForegroundService.running && live != null) {
      live.rearm(maxMs)
      return
    }
    try {
      MessageSyncForegroundService.ensureChannel(reactCtx)
      val intent = Intent(reactCtx, MessageSyncForegroundService::class.java).apply {
        putExtra(MessageSyncForegroundService.EXTRA_BODY, body ?: MessageSyncForegroundService.DEFAULT_BODY)
        putExtra(MessageSyncForegroundService.EXTRA_MAX_MS, maxMs)
      }
      ContextCompat.startForegroundService(reactCtx, intent)
    } catch (t: Throwable) {
      // Android 12+ can refuse at the CALL site too (ForegroundServiceStartNotAllowedException).
      Log.w(TAG, "start refused: ${t.javaClass.simpleName}: ${t.message} — falling back to expedited job")
      MessageSyncJobService.scheduleExpedited(reactCtx, maxMs)
    }
  }

  private fun stopForegroundService() {
    try {
      reactCtx.stopService(Intent(reactCtx, MessageSyncForegroundService::class.java))
    } catch (t: Throwable) {
      Log.w(TAG, "stop failed", t)
    }
  }

  companion object {
    const val TAG = "BravoMessageSync"
    const val STOP_GRACE_MS = 600L
  }
}
