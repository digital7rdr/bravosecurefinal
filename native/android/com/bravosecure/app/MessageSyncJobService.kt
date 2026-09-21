package com.bravosecure.app

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * B-776 (rev4) — the NOTIFICATION-FREE receive hold for Android 12+.
 *
 * An expedited job (JobInfo.setExpedited) is bound by JobScheduler WITHOUT
 * BIND_NOT_FOREGROUND, so while it runs the process is scheduled in the
 * foreground group exactly like a foreground service — but no notification
 * is required. That is the property the founder asked for: "Checking for new
 * messages…" flashing in the shade on every message of a conversation was
 * the one visible cost of the foreground-service hold (HyperOS does not
 * honour FOREGROUND_SERVICE_DEFERRED, so even a 2 s hold showed a card).
 *
 * Quota: expedited jobs draw from a per-app budget (generous in the ACTIVE /
 * EXEMPTED standby buckets). When exhausted, `params.isExpeditedJob()` is
 * false and the job runs at ordinary priority — the receive still completes,
 * just as it did before this hold existed. The mode is logged so a device
 * capture shows which lane a receive got.
 *
 * Lifetime: `onStartJob` keeps the job open (returns true) until the module
 * calls `finish()` on the last JS release, or the watchdog fires. A job that
 * starts in a process with NO React instance (the app was swiped away and
 * JobScheduler re-created the process to run a pending job) finishes at once
 * so a killed app never boots itself back to life for a stale hold.
 *
 * NOTE: android/ is .gitignored — this file is force-added (git add -f).
 */
class MessageSyncJobService : JobService() {
  private val handler = Handler(Looper.getMainLooper())
  private var params: JobParameters? = null
  private val watchdog = Runnable {
    Log.w(TAG, "watchdog: hold exceeded maxMs — finishing job")
    finish()
  }

  override fun onStartJob(p: JobParameters): Boolean {
    if (!ReactInstanceProbe.isAlive(applicationContext)) {
      // The process was created to run this job (app swiped away meanwhile).
      Log.w(TAG, "no React instance — finishing immediately (no resurrection)")
      return false
    }
    params = p
    instance = this
    running = true
    expedited = p.isExpeditedJob
    Log.i(TAG, "job started expedited=$expedited")
    rearm(MessageSyncForegroundService.DEFAULT_MAX_MS)
    return true
  }

  override fun onStopJob(p: JobParameters): Boolean {
    // The system reclaimed the job (quota / runtime limit). Do not reschedule.
    Log.w(TAG, "onStopJob reason=${if (android.os.Build.VERSION.SDK_INT >= 31) p.stopReason else -1}")
    clear()
    return false
  }

  fun rearm(maxMs: Long) {
    handler.removeCallbacks(watchdog)
    handler.postDelayed(watchdog, MessageSyncForegroundService.clampMaxMs(maxMs))
  }

  fun finish() {
    val p = params
    clear()
    if (p != null) {
      try { jobFinished(p, false) } catch (t: Throwable) { Log.w(TAG, "jobFinished failed", t) }
    }
  }

  private fun clear() {
    handler.removeCallbacks(watchdog)
    params = null
    running = false
    expedited = false
    if (instance === this) instance = null
  }

  override fun onDestroy() {
    clear()
    super.onDestroy()
  }

  companion object {
    const val TAG = "BravoMsgSyncJob"
    const val JOB_ID = 70312

    @Volatile var running: Boolean = false
      private set
    @Volatile var expedited: Boolean = false
      private set
    @Volatile var instance: MessageSyncJobService? = null
      private set

    /** Schedule (or re-arm) the expedited hold. Safe from any thread. */
    fun scheduleExpedited(ctx: Context, maxMs: Long) {
      val live = instance
      if (running && live != null) {
        live.rearm(maxMs)
        return
      }
      try {
        val scheduler = ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
        val info = JobInfo.Builder(JOB_ID, ComponentName(ctx, MessageSyncJobService::class.java))
          .setExpedited(true)
          .build()
        val result = scheduler.schedule(info)
        if (result != JobScheduler.RESULT_SUCCESS) {
          Log.w(TAG, "expedited job not scheduled result=$result")
        }
      } catch (t: Throwable) {
        Log.w(TAG, "job schedule failed: ${t.javaClass.simpleName}: ${t.message}")
      }
    }

    fun finishOrCancel(ctx: Context) {
      val live = instance
      if (live != null) {
        live.finish()
        return
      }
      try {
        val scheduler = ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
        scheduler.cancel(JOB_ID)
      } catch (t: Throwable) {
        Log.w(TAG, "job cancel failed", t)
      }
    }
  }
}
