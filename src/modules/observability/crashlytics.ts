/**
 * Crash / error reporting wrapper — the app's single observability chokepoint.
 *
 * 2026-09-27: backed by the Sentry protocol (sentry.ts — hosted Sentry or a
 * self-hosted GlitchTip) instead of Firebase Crashlytics + Analytics. The file
 * keeps its old name and exports so the existing imports and the test mocks of
 * '../../observability/crashlytics' keep working unchanged.
 *
 * Why a wrapper instead of importing the SDK directly:
 *   - One chokepoint for redaction. Crash reports must NOT contain plaintext
 *     message bodies, identity keys, or session fingerprints. Every `log()` and
 *     `recordError()` call passes through `redact()`, and sentry.ts scrubs the
 *     final event again in beforeSend.
 *   - Lets unit tests stub the whole surface with one mock module.
 *   - No-ops on web / dev / Jest (no DSN) without try/catch sprinkled across
 *     the codebase.
 *
 * Product analytics (the old Firebase Analytics `trackEvent`) is gone on
 * purpose: nothing called it, and a secure messenger should not ship a usage
 * tracker by default. `trackEvent` stays as a breadcrumb so call sites compile.
 */
import {redact} from './redact';
import {
  addBreadcrumb,
  captureException,
  initSentry,
  nativeCrash,
  setCollectionEnabled as sentrySetCollectionEnabled,
  setSentryUser,
  setTag,
} from './sentry';

// ── Initialization ─────────────────────────────────────────────────

let initialized = false;

/** Name kept for index.js; boots the Sentry transport (no-op without a DSN). */
export function initCrashlytics(): void {
  if (initialized) {return;}
  initialized = true;
  try {
    initSentry();
    addBreadcrumb({category: 'bravo', message: '[bravo.observability] crash reporter ready'});
  } catch (e) {
    // Observability code must never crash the app.
    if (__DEV__) {console.warn('[bravo.observability] init failed:', e);}
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Record a non-fatal JS error. Use for caught exceptions where the app
 * continues running (e.g. failed-to-decrypt envelope, message send retry
 * exhausted). Fatal JS crashes and native crashes are recorded automatically
 * by the SDK.
 */
export function recordError(err: unknown, context?: Record<string, string | number | boolean>): void {
  try {
    const extra: Record<string, string | number | boolean> = {};
    if (context) {
      for (const [k, v] of Object.entries(context)) {
        extra[k] = typeof v === 'string' ? redact(v) : v;
      }
    }
    let safe: Error;
    if (err instanceof Error) {
      safe = new Error(redact(err.message));
      safe.name = err.name;
      safe.stack = err.stack ? redact(err.stack) : undefined;
    } else {
      safe = new Error(redact(String(err)));
    }
    captureException(safe, context ? {extra} : undefined);
  } catch {
    /* never throw from observability */
  }
}

/**
 * Add a breadcrumb (visible in the timeline preceding a crash). Keep
 * messages short and structured: `[bravo.area] action key=value`.
 * NEVER pass user-generated content here.
 */
export function log(message: string): void {
  try {
    addBreadcrumb({category: 'bravo', message: redact(message), level: 'info'});
  } catch {
    /* never throw */
  }
  // Diagnostic: the deliver/receive path reports decrypt-failure reasons
  // (ws-handle-failed, ws-identity-rotation, identity-mismatch) via this
  // wrapper, not console — mirror them into the group-call trace file when
  // the diagnostic flag is set. No-op otherwise. Lazy require avoids any
  // import cycle and keeps this module dependency-light.
  try {
    const {mirrorToFile} = require('./fileLog') as typeof import('./fileLog');
    mirrorToFile('CRASH', message);
  } catch {
    /* fileLog unavailable — fine */
  }
}

/**
 * Stamp the current user id on subsequent reports. Use a hashed /
 * pseudonymous id, not a phone number or email.
 */
export function setUser(id: string | null): void {
  try {
    setSentryUser(id ? {id} : null);
  } catch {
    /* never throw */
  }
}

/**
 * Tag a long-lived attribute on every subsequent report.
 * Examples: `app_screen`, `runtime_mode`, `network_kind`.
 */
export function setAttribute(key: string, value: string | number | boolean): void {
  try {
    setTag(key, redact(String(value)));
  } catch {
    /* never throw */
  }
}

/**
 * Former Firebase Analytics event. Recorded only as a breadcrumb (so it shows
 * in the timeline before an error); nothing is sent on its own.
 */
export function trackEvent(name: string, params?: Record<string, string | number | boolean>): void {
  try {
    const data: Record<string, string | number | boolean> = {};
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        data[k] = typeof v === 'string' ? redact(v) : v;
      }
    }
    addBreadcrumb({category: 'event', message: redact(name), data});
  } catch {
    /* never throw */
  }
}

/**
 * Toggle collection at runtime — for the Privacy screen. While off, events
 * are dropped before they leave the device.
 */
export async function setCollectionEnabled(enabled: boolean): Promise<void> {
  try {
    sentrySetCollectionEnabled(enabled);
  } catch {
    /* never throw */
  }
}

/**
 * Test-only — force a native crash so you can verify the dashboard
 * receives reports end-to-end. NEVER call this from production code
 * paths; it's gated by __DEV__.
 */
export function devForceCrash(): void {
  if (!__DEV__) {return;}
  try {
    nativeCrash();
  } catch {
    /* native crash doesn't return; this catches the no-op path */
  }
}
