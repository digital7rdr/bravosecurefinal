/**
 * On-duty location heartbeat (BUILD_RUNBOOK Step 5).
 *
 * Why: the dispatch matchmaker (Step 6) can only rank agencies it can locate.
 * The existing watcher in AgentDashboardScreen reports location ONLY during a
 * live mission and ONLY in the foreground (P0 / LB16) — so a freshly-online
 * agency with no active mission reports nothing and never gets offered jobs.
 * This heartbeat is gated on DUTY, not on a mission: while the agency is
 * "Online" it PATCHes /agents/me/location on a timer so the dispatch pool sees
 * a fresh `agents.last_location_at`.
 *
 * BACKGROUND NOTE (device-verify required): a bare setInterval is suspended when
 * the app is backgrounded. True background survival needs this loop to run under
 * an Android foreground service (FOREGROUND_SERVICE_LOCATION) — either notifee's
 * registerForegroundService or a native module like CallForegroundService. That
 * native wiring + an on-device smoke test is the remaining piece; the manifest
 * permissions are in place and acquire/releaseKeepAlive() below are the
 * integration point. In the foreground this already closes the "only during a
 * mission" gap (LB16). Do not assume background "just works" without the service.
 */
import Geolocation from 'react-native-geolocation-service';
import {agentApi} from './api';

/**
 * Staleness cutoff: an on-duty agency is "locatable" only if its last fix is
 * newer than this. Mirrors the dispatch ranking query's freshness filter —
 * specifically the server's `DISPATCH_LOCATION_FRESH_MINUTES` default. If ops
 * ever move that, this constant has to move with it or the duty UI will claim
 * the agency is dispatchable while the ranking has already dropped it (or the
 * reverse). There is no client-side read of the server value today.
 */
export const LOCATION_FRESH_MINUTES = 5;

const HEARTBEAT_INTERVAL_MS = 45_000; // ~45s — within the 30–60s window
const FIX_TIMEOUT_MS = 15_000;

/** True when an on-duty agency has pushed a fix newer than LOCATION_FRESH_MINUTES. */
export function isLocatable(
  onDuty: boolean,
  lastPushAt: number | null,
  nowMs: number = Date.now(),
): boolean {
  if (!onDuty || lastPushAt === null) {
    return false;
  }
  return nowMs - lastPushAt < LOCATION_FRESH_MINUTES * 60_000;
}

interface Fix {
  lat: number;
  lng: number;
  // Step 23 anti-fraud — report fix quality so the server can gate spoofed positions.
  accuracy_m?: number;
  speed_kph?: number;
  is_mocked?: boolean;
}

function getFix(): Promise<Fix | null> {
  return new Promise(resolve => {
    Geolocation.getCurrentPosition(
      p => resolve({
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        accuracy_m: p.coords.accuracy ?? undefined,
        // coords.speed is m/s (or null/-1 when unknown) — convert to km/h.
        speed_kph: typeof p.coords.speed === 'number' && p.coords.speed >= 0
          ? Math.round(p.coords.speed * 3.6) : undefined,
        // Android exposes a mocked flag on the position; iOS omits it (undefined).
        is_mocked: (p as {mocked?: boolean}).mocked === true ? true : undefined,
      }),
      () => resolve(null),
      {enableHighAccuracy: true, timeout: FIX_TIMEOUT_MS},
    );
  });
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastPushAt: number | null = null;
let onPushCb: ((at: number) => void) | null = null;
let inFlight = false;

/**
 * E2E-17 — subscribers to the duty LINK state.
 *
 * Android suspends this interval the moment the app is backgrounded, so
 * `agents.last_location_at` goes stale in ~5 minutes; the dispatch ranking then
 * excludes the agency and the offer-expiry sweep kills any live offer as
 * "holder gone" — which ALSO charges decline accounting, so the agency earns a
 * cooldown for having its app in the background. That mechanism is not fixed
 * here (see the keep-alive note at the bottom), but it must stop being
 * invisible: the UI subscribes and tells the user plainly that they are no
 * longer receiving offers, instead of painting a green "Online".
 */
const linkSubs = new Set<() => void>();
function emitLinkChange(): void {
  for (const cb of Array.from(linkSubs)) {
    try { cb(); } catch { /* a bad subscriber must never break the heartbeat */ }
  }
}

/** Subscribe to duty-link changes (a push landed, or the heartbeat stopped). */
export function subscribeDutyLink(cb: () => void): () => void {
  linkSubs.add(cb);
  return () => { linkSubs.delete(cb); };
}

export type DutyLinkState =
  /** Not on duty / no heartbeat running. */
  | 'off'
  /** Running, but no fix has landed yet (first fix, or permission/GPS denied). */
  | 'connecting'
  /** A fresh fix is on the server — the agency IS in the dispatch pool. */
  | 'live'
  /** The last fix is older than the ranking's freshness filter — NOT dispatchable. */
  | 'stale';

/**
 * What the server currently believes about this agency's locatability.
 *
 * `stale` is the honest answer for "the app was backgrounded and Android froze
 * the timer": the row the matchmaker reads is out of date, so no offer can
 * reach us, whatever the duty toggle says.
 */
export function dutyLinkState(nowMs: number = Date.now()): DutyLinkState {
  if (timer === null) {return 'off';}
  if (lastPushAt === null) {return 'connecting';}
  return isLocatable(true, lastPushAt, nowMs) ? 'live' : 'stale';
}

/** Resolves TRUE only when a fix was obtained AND accepted by the server. */
async function pushOnce(): Promise<boolean> {
  if (inFlight) {
    return false; // a slow fix / PATCH is still running — skip this tick, don't pile up
  }
  inFlight = true;
  try {
    const fix = await getFix();
    if (fix) {
      await agentApi.updateLocation(fix.lat, fix.lng, {
        accuracy_m: fix.accuracy_m, speed_kph: fix.speed_kph, is_mocked: fix.is_mocked,
      });
      lastPushAt = Date.now();
      onPushCb?.(lastPushAt);
      emitLinkChange();
      return true;
    }
    return false;   // no fix — permission denied, GPS off, or a timeout
  } catch {
    // Swallow transient fix / network errors — the next tick retries (mirrors
    // the existing mission watcher's fire-and-forget reporting). lastPushAt is
    // left unchanged so a failed push never reports a phantom fresh fix.
    return false;
  } finally {
    inFlight = false;
  }
}

/** Start the on-duty heartbeat. Idempotent — a second start() while running
 *  only refreshes the onPush callback, it does NOT spawn a second timer. */
export function startOnDutyHeartbeat(opts?: {onPush?: (at: number) => void}): void {
  if (opts?.onPush) {
    onPushCb = opts.onPush;
  }
  if (timer !== null) {
    return;
  }
  acquireKeepAlive();
  void pushOnce(); // immediate first fix the moment we go Online
  timer = setInterval(() => {
    void pushOnce();
  }, HEARTBEAT_INTERVAL_MS);
}

/** Stop the heartbeat. Idempotent. */
export function stopOnDutyHeartbeat(): void {
  const wasRunning = timer !== null;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  // Forget the last duty session so getLastPushAt() can't report an old fix as
  // fresh, and drop the screen's onPush ref for a clean teardown.
  lastPushAt = null;
  onPushCb = null;
  inFlight = false;
  releaseKeepAlive();
  if (wasRunning) {emitLinkChange();}
}

/**
 * E2E-17 — push a fix RIGHT NOW without waiting for the next interval tick.
 *
 * Called when the app comes back to the foreground: Android froze the interval
 * while we were backgrounded, so the very first thing to do on return is refresh
 * `agents.last_location_at` and get back into the dispatch pool, rather than
 * sitting stale for up to another interval. No-op when off duty.
 */
export function pingOnDutyHeartbeat(): Promise<boolean> {
  if (timer === null) {return Promise.resolve(false);}
  return pushOnce();
}

export function isHeartbeatRunning(): boolean {
  return timer !== null;
}

export function getLastPushAt(): number | null {
  return lastPushAt;
}

// ── Background keep-alive (foreground service) ──────────────────────────────
//
// E2E-17, decision recorded 2026-09-03. A real keep-alive IS reachable with an
// already-installed dependency: `src/modules/agent/missionForegroundService.ts`
// runs notifee's FOREGROUND_SERVICE_TYPE_LOCATION service to keep the LEAD's
// mission telemetry alive (B-89 MG-03). It was NOT reused here, deliberately:
//
//   * notifee registers exactly ONE foreground-service task per process, and the
//     mission service owns it (`registerForegroundService` at bundle entry, one
//     `stopRunner`, the fixed 'mission-tracking' notification id). A second
//     asForegroundService notification would contend for the same service and
//     the same stop path — a duty stop could tear down a LIVE mission's GPS.
//   * That is a device-verified surface with an ordered generation/serial-chain
//     protocol; changing its ownership without a device pass is exactly the
//     class of change that produced B-339.
//
// So the honest half shipped instead: `dutyLinkState()` + `subscribeDutyLink()`
// let the duty UI say plainly that the agency has dropped out of the dispatch
// pool, and `pingOnDutyHeartbeat()` re-registers the moment the app is back on
// screen. Wiring a second (or shared, arbitrated) foreground service stays owed
// and is device-gated.
//
// start/stop must NEVER throw, so the foreground heartbeat keeps working
// regardless of what is wired here later.
function acquireKeepAlive(): void {
  /* TODO(E2E-17): arbitrate a shared FOREGROUND_SERVICE_LOCATION service with
     missionForegroundService, then start it here. Device pass required. */
}
function releaseKeepAlive(): void {
  /* TODO(E2E-17): release the shared foreground service (only when no mission
     is holding it — see the note above). */
}
