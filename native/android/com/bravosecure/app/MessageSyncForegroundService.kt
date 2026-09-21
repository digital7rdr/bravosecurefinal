package com.bravosecure.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * B-776 — short-lived data-sync foreground service held while a message is
 * being received with the app in the background.
 *
 * Why: a backgrounded RN process runs in Android's `background` cgroup
 * (little cores, a few percent of CPU under contention). Measured on the
 * Redmi Note 11 (2026-09-02 audit): the same decrypt+persist took 1.8 s on
 * screen and 11–23 s in the background. A foreground service moves the
 * process to the foreground scheduling group for the seconds the work takes —
 * the mechanism WhatsApp (`GcmFGService`) and Signal
 * (`FcmFetchForegroundService`) use on the push wake.
 *
 * Contract:
 *  - Started/stopped ONLY from BravoMessageSyncModule (JS refcount in
 *    receiveForegroundHold.ts). Never exported.
 *  - `running` is the ONE source of truth for "the FGS is up" (critic F1):
 *    JS cannot see a refused start, so the module consults this flag and JS
 *    asks for a start on every hold. A hold while running only RE-ARMS the
 *    watchdog (`rearm`) — it never re-posts the notification: the device
 *    pass showed the sealed-archive replay feeding hundreds of envelopes
 *    through the receive path back-to-back, and a re-post per envelope
 *    flickered the shade every ~370 ms.
 *  - A watchdog stops the service after `maxMs` even if JS never calls stop
 *    (headless VM torn down mid-hold); each start/rearm re-arms it.
 *  - `startForeground` can be refused on Android 12+ when the app is
 *    backgrounded without an exemption (no high-priority-push window, not
 *    battery-exempt). That is caught: the receive proceeds at background
 *    priority exactly as before this service existed.
 *  - The notification sits on its OWN minimum-importance channel (no
 *    status-bar icon on Android 8–11, where FOREGROUND_SERVICE_DEFERRED is a
 *    no-op) and is DEFERRED on 12+, so a receive that finishes inside
 *    Android's ~10 s deferral window shows nothing at all in the shade. The
 *    killed-lane notifee placeholder (LOW channel) keeps its own row.
 *
 * NOTE: android/ is .gitignored — this file is force-added (git add -f), like
 * CallForegroundService.kt. Keep it tracked.
 */
class MessageSyncForegroundService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val watchdog = Runnable {
    Log.w(TAG, "watchdog: hold exceeded maxMs — stopping")
    finish()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      finish()
      return START_NOT_STICKY
    }
    if (!ReactInstanceProbe.isAlive(applicationContext)) {
      // A pending start re-delivered to a process Android re-created after the
      // user swiped the app away: nothing to hold for, and holding would keep
      // the empty process alive. Post-then-remove satisfies the FGS contract.
      Log.w(TAG, "no React instance — refusing to hold (no resurrection)")
      ensureChannel(this)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          startForeground(NOTIF_ID, buildNotification(DEFAULT_BODY), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
          startForeground(NOTIF_ID, buildNotification(DEFAULT_BODY))
        }
      } catch (t: Throwable) { /* refused — fine, we are stopping anyway */ }
      finish()
      return START_NOT_STICKY
    }
    val maxMs = clampMaxMs(intent?.getLongExtra(EXTRA_MAX_MS, DEFAULT_MAX_MS) ?: DEFAULT_MAX_MS)
    if (running) {
      // Already in the foreground: a repeat start intent is only a re-arm.
      rearm(maxMs)
      return START_NOT_STICKY
    }
    val body = intent?.getStringExtra(EXTRA_BODY)?.takeIf { it.isNotBlank() } ?: DEFAULT_BODY
    ensureChannel(this)
    val notification = buildNotification(body)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(NOTIF_ID, notification)
      }
      running = true
    } catch (t: Throwable) {
      // ForegroundServiceStartNotAllowedException (API 31+) or a missing typed
      // permission. Not fatal: fall back to the expedited job (weaker boost,
      // never refused for a temp-allowlisted / exempt app), else the receive
      // simply continues at background priority as before this hold existed.
      Log.w(TAG, "startForeground refused: ${t.javaClass.simpleName}: ${t.message} — falling back to expedited job")
      running = false
      MessageSyncJobService.scheduleExpedited(applicationContext, maxMs)
      stopSelf()
      return START_NOT_STICKY
    }
    rearm(maxMs)
    return START_NOT_STICKY
  }

  /** Push the watchdog out again; never touches the notification. */
  fun rearm(maxMs: Long) {
    handler.removeCallbacks(watchdog)
    handler.postDelayed(watchdog, clampMaxMs(maxMs))
  }

  // Android 15+: a dataSync FGS has a daily budget; the system calls this when
  // it is exhausted and ANRs the process if the service does not stop promptly.
  override fun onTimeout(startId: Int, fgsType: Int) {
    Log.w(TAG, "onTimeout: dataSync budget exhausted — stopping")
    finish()
  }

  override fun onDestroy() {
    handler.removeCallbacks(watchdog)
    running = false
    if (instance === this) instance = null
    stopForegroundCompat()
    super.onDestroy()
  }

  private fun finish() {
    handler.removeCallbacks(watchdog)
    running = false
    stopForegroundCompat()
    stopSelf()
  }

  private fun stopForegroundCompat() {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        stopForeground(STOP_FOREGROUND_REMOVE)
      } else {
        @Suppress("DEPRECATION")
        stopForeground(true)
      }
    } catch (t: Throwable) {
      Log.w(TAG, "stopForeground failed", t)
    }
  }

  private fun buildNotification(body: String): Notification {
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    val contentIntent = launch?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_bravo)
      .setContentTitle("Bravo Secure")
      .setContentText(body)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED)
      .apply { if (contentIntent != null) setContentIntent(contentIntent) }
      .build()
  }

  companion object {
    const val TAG = "BravoMsgSyncFgs"
    const val ACTION_STOP = "com.bravosecure.app.MSG_SYNC_STOP"
    const val EXTRA_BODY = "body"
    const val EXTRA_MAX_MS = "maxMs"
    const val NOTIF_ID = 70311
    // rev5 — a SILENCED channel (IMPORTANCE_NONE). Android still runs the
    // service at foreground priority; the card is never drawn, and the only
    // trace is the shade's "active app" entry for the seconds of the hold. The
    // founder found the per-message "Checking for new messages…" card annoying
    // and the expedited-job lane (no card) measured ~2× slower on HyperOS,
    // which pins job-bound processes in cpuset:/background. New id: a channel's
    // importance cannot be changed after creation, and 'bravo-messages-sync'
    // already exists as MIN on the test phone.
    const val CHANNEL_ID = "bravo-messages-sync-silent"
    const val DEFAULT_BODY = "Checking for new messages…"
    const val DEFAULT_MAX_MS = 45_000L
    const val MIN_MAX_MS = 1_000L
    const val HARD_MAX_MS = 120_000L

    /** True between a successful startForeground and onDestroy/refusal. */
    @Volatile
    var running: Boolean = false
      private set

    /** The live service, for a main-looper re-arm without a start intent. */
    @Volatile
    var instance: MessageSyncForegroundService? = null
      private set

    fun clampMaxMs(maxMs: Long): Long = maxMs.coerceIn(MIN_MAX_MS, HARD_MAX_MS)

    fun ensureChannel(ctx: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (nm.getNotificationChannel(CHANNEL_ID) != null) return
      val ch = NotificationChannel(CHANNEL_ID, "Background sync", NotificationManager.IMPORTANCE_NONE).apply {
        enableVibration(false)
        setSound(null, null)
        setShowBadge(false)
      }
      nm.createNotificationChannel(ch)
    }
  }
}
