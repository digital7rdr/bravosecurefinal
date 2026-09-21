/**
 * B-776 — the receive-side foreground hold.
 *
 * A backgrounded RN process sits in Android's `background` cgroup, and the
 * 2026-09-02 device capture (`docs/qa/BACKGROUND_DELIVERY_AUDIT_2026-09-02.md`)
 * measured the SAME decrypt+persist at 1.8 s on screen versus 11 s (warm) /
 * 23 s (first contact) there. The push wake elevates only the RNFB headless
 * task; the socket lane that actually handles the envelope runs starved.
 *
 * WhatsApp answers this with a data-sync foreground service for the seconds
 * the receive takes (`GcmFGService`); Signal with `FcmFetchForegroundService`.
 * This module is that: a refcounted hold on BravoMessageSync (a dedicated
 * native service — notifee allows ONE registered foreground-service runner and
 * the mission GPS tracker already owns it).
 *
 * Rules:
 *  - No-op when the UI is on screen (`AppState 'active'`): the process is
 *    already top-app and an FGS would only add chrome.
 *  - No-op when the native module is absent (iOS, web, unbuilt tree, tests).
 *  - Refcounted: the relay's flush-on-connect delivers N envelopes at once;
 *    the service stops on the last release.
 *  - `start` is asked on EVERY hold (critic F1). JS cannot see a refused
 *    native start, so it must not remember one as a success: the native side
 *    holds the truth ("running") and turns a start on a live service into a
 *    watchdog re-arm — never a notification re-post (device pass: the
 *    sealed-archive replay feeds hundreds of envelopes back-to-back).
 *  - A hold that never releases (a wedged receive — the B-126 class) is
 *    evicted after RECEIVE_HOLD_MAX_MS so it cannot pin the count forever
 *    (critic F2); the native watchdog has stopped the service by then anyway.
 *  - The stop grace and the max-lifetime watchdog live NATIVELY — RN pauses
 *    JS timers for a backgrounded process, so a JS timer is not reliable here.
 *  - Never throws: a refused foreground service leaves the receive exactly as
 *    it was before this module existed.
 *
 * Logs are `[NOTIFLAT]`-style warn lines (release-visible), enums and numbers
 * only (logAudit posture), rate-limited: a back-to-back burst logs its first
 * hold and, at most every LOG_FLOOR_MS, a release with the burst's totals.
 */
import {AppState, NativeModules, Platform} from 'react-native';

interface MessageSyncNative {
  start(opts: {body: string; maxMs: number}): void;
  stop(): void;
}

export type ReceiveHoldReason = 'ws' | 'warm-wake' | 'headless-wake' | 'drain';

/** Hard ceiling for one hold — the native watchdog stops the service at this age. */
export const RECEIVE_HOLD_MAX_MS = 45_000;
/** Minimum spacing between log lines of the same kind. */
const LOG_FLOOR_MS = 2_000;

let holds = 0;
let active = false;
let activeSince = 0;
let lastHoldLogAt = 0;
let lastReleaseLogAt = 0;
let burstHolds = 0;

function native(): MessageSyncNative | null {
  if (Platform.OS !== 'android') {return null;}
  const mod = (NativeModules as Record<string, unknown>).BravoMessageSync as MessageSyncNative | undefined;
  return mod && typeof mod.start === 'function' && typeof mod.stop === 'function' ? mod : null;
}

function evictStale(now: number): void {
  if (active && now - activeSince > RECEIVE_HOLD_MAX_MS) {
    console.warn(`[recvFgs] stale hold evicted holds=${holds} ageMs=${now - activeSince}`);
    holds = 0;
    active = false;
  }
}

/**
 * Acquire the hold. Returns the release function; releasing twice is a no-op.
 * Synchronous on purpose — it sits on the receive critical path.
 */
export function holdReceiveForeground(reason: ReceiveHoldReason): () => void {
  const mod = native();
  if (!mod || AppState.currentState === 'active') {
    return () => { /* nothing held */ };
  }
  const now = Date.now();
  evictStale(now);
  holds += 1;
  burstHolds += 1;
  try {
    // Every hold asks; native decides (start, or re-arm a running service).
    mod.start({body: 'Checking for new messages…', maxMs: RECEIVE_HOLD_MAX_MS});
    if (!active) {
      active = true;
      activeSince = now;
      if (now - lastHoldLogAt >= LOG_FLOOR_MS) {
        lastHoldLogAt = now;
        console.warn(`[NOTIFLAT] recvFgs hold reason=${reason}`);
      }
    }
  } catch (e) {
    console.warn('[recvFgs] start failed:', (e as Error).message);
  }
  let released = false;
  return () => {
    if (released) {return;}
    released = true;
    holds = Math.max(0, holds - 1);
    if (holds === 0 && active) {
      active = false;
      try {
        mod.stop();
        const t = Date.now();
        if (t - lastReleaseLogAt >= LOG_FLOOR_MS) {
          lastReleaseLogAt = t;
          console.warn(`[NOTIFLAT] recvFgs release reason=${reason} heldMs=${t - activeSince} burstHolds=${burstHolds}`);
          burstHolds = 0;
        }
      } catch (e) {
        console.warn('[recvFgs] stop failed:', (e as Error).message);
      }
    }
  };
}

/** Diagnostics / tests. */
export function activeReceiveHolds(): number {
  return holds;
}

export function isReceiveHoldActive(): boolean {
  return active;
}

export function _resetReceiveHoldForTests(): void {
  holds = 0;
  active = false;
  activeSince = 0;
  lastHoldLogAt = 0;
  lastReleaseLogAt = 0;
  burstHolds = 0;
}
