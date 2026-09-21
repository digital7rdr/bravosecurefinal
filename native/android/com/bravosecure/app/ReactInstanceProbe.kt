package com.bravosecure.app

import android.content.Context
import com.facebook.react.ReactApplication

/**
 * B-776 (rev4) — "is JavaScript alive in this process?"
 *
 * Both receive-hold services consult this before holding: a service or job
 * start delivered to a process that Android re-created AFTER the user swiped
 * the app away must not keep that empty process alive (the founder saw Bravo
 * come back five seconds after killing it — a pending foreground-service
 * start re-delivered by ActivityManager).
 */
object ReactInstanceProbe {
  fun isAlive(ctx: Context): Boolean {
    return try {
      val app = ctx.applicationContext as? ReactApplication ?: return false
      val host = app.reactHost
      if (host != null && host.currentReactContext != null) return true
      @Suppress("DEPRECATION")
      app.reactNativeHost.hasInstance()
    } catch (t: Throwable) {
      false
    }
  }
}
