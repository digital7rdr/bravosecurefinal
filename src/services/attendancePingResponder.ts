/**
 * B-859 — the worker's side of a manager location ping.
 *
 * Founder, 2026-09-11: _"attendance: if I give a shift to a user for any day,
 * there should be an option to ping each user; if an admin or higher pings a
 * person they should see their location while on shift. Other than shift, if
 * pinged, don't share location."_
 *
 * ── THE DEVICE NEVER DECIDES WHETHER THE WORKER IS ON SHIFT ──────────────────
 *
 * That sentence reads like a client-side gate and must not be built as one. A
 * worker can be assigned to two shifts in two organisations at once, and a local
 * check would consult ONE of them — whichever store happened to be warm — and
 * either refuse a legitimate request or answer an illegitimate one. The server
 * is the only gate: it refuses the REQUEST unless there is an open session for
 * that shift, and re-checks at ANSWER time and drops the coordinates if the
 * worker has clocked out in between. So this module takes a fix and answers;
 * the decision is not its business.
 *
 * ── WHAT IT DOES DECIDE ──────────────────────────────────────────────────────
 *
 * Only what the device knows about itself: is location permitted, and is there a
 * fix. Both are REPORTED (`refuse`), never silence — a manager staring at
 * "waiting…" for ten minutes cannot tell a denied permission from a dead phone.
 *
 * ── THE FIX OPTIONS ARE COPIED VERBATIM, AND THAT IS LOAD-BEARING ────────────
 *
 * `showLocationDialog` DEFAULTS TO TRUE in react-native-geolocation-service, and
 * on a granted-permission device whose Location master toggle is off the
 * FusedLocationProvider takes its RESOLUTION_REQUIRED branch and throws up the
 * Google Play "turn on device location" SYSTEM MODAL. This lane fires while the
 * worker is on duty — possibly with the clock-in camera open — so it must put
 * nothing on screen. `forceRequestLocation` is the other half: it lets a
 * network-only provider answer when the settings are not "satisfied".
 * See `src/screens/vbg/silentLocationFix.ts`, whose options these are.
 */
import type {PingStatusDto} from '@services/api';

export type PingResponseOutcome = 'answered' | 'refused' | 'failed' | 'duplicate';

/**
 * Pings the SERVER has given a terminal answer for.
 *
 * A single ping can reach the app twice — the wake AND the tap on the card it
 * drew — and answering twice means two fixes for one question. The server is
 * idempotent enough not to corrupt anything, but the second fix is a location
 * capture nobody asked for, which is exactly what this feature must not do.
 *
 * ⚠️ TERMINAL, not "attempted". The first cut marked an id here BEFORE the POST
 * and never removed it, which broke the card lane in both directions: a network
 * failure left the id latched, so the card the wake then drew ("Tap to share
 * your location") had a DEAD tap — the only recovery path this feature has,
 * silently gone; and a duplicate FCM for an id that had already been answered
 * came back `'failed'`, which the wake reads as "not handled" and answers with a
 * spurious card for a question already settled. Membership of this set means one
 * thing only: asking again would be a second capture.
 */
const handled = new Set<string>();

/**
 * Pings with a request in flight RIGHT NOW.
 *
 * The re-entrancy guard the set above was doing badly. Two deliveries landing in
 * the same tick must not both take a fix; but an id that failed must not stay
 * locked out, because the tap on its card is the retry.
 */
const inFlight = new Set<string>();

/** Test seam only. */
export function __resetPingResponderForTests(): void {
  handled.clear();
  inFlight.clear();
}

/**
 * Is a location fix permitted right now? COARSE counts — Android 12+ lets the
 * user grant "Approximate location" only, which leaves FINE denied, and an
 * approximate answer is still an answer to "where are you".
 *
 * NOTHING here REQUESTS a permission. A permission prompt raised by a
 * background wake is a dialog the worker cannot connect to anything they did.
 */
async function locationPermitted(): Promise<boolean> {
  const {Platform, PermissionsAndroid} = require('react-native') as typeof import('react-native');
  if (Platform.OS !== 'android') {return true;}
  const [fine, coarse] = await Promise.all([
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION),
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION),
  ]);
  return fine || coarse;
}

/**
 * The TWO asks, in order. B-866 (device, 1.0.312): the cheap first ask is
 * answered from the provider's cache — `RNFusedLocation: returning cached
 * location` on both pings that came back in under 3 s — and simply times out
 * when there is nothing cached, which is exactly the state a map-heavy screen
 * leaves the provider in. So an empty first ask is not "this phone has no
 * location", it is "nothing was lying around"; the retry is the question that
 * actually costs something. 8 s + 20 s is 0.5% of the ping's ten-minute life.
 *
 * `showLocationDialog` / `forceRequestLocation` are VERBATIM from
 * silentLocationFix on BOTH attempts — see the header note. The retry raises
 * accuracy and the timeout and nothing else; it must not become a second way to
 * put a system modal in front of a worker on duty.
 */
const FIRST_TRY = {enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000} as const;
const RETRY     = {enableHighAccuracy: true,  timeout: 20_000, maximumAge: 0} as const;

async function oneFix(
  ask: {enableHighAccuracy: boolean; timeout: number; maximumAge: number},
): Promise<{lat: number; lng: number; accuracy_m?: number; mocked?: boolean} | null> {
  // The package's TYPES declare a namespace with no `default`, while its RUNTIME
  // ships an ES default — so the require is interop-unwrapped by hand and typed
  // off the namespace. `import Geolocation from …` (the two other call sites)
  // is not available here: this module is lazy-required from a headless VM.
  const mod = require('react-native-geolocation-service') as
    typeof import('react-native-geolocation-service') & {default?: typeof import('react-native-geolocation-service')};
  const Geolocation = mod.default ?? mod;
  return new Promise(resolve => {
    Geolocation.getCurrentPosition(
      (p: import('react-native-geolocation-service').GeoPosition) =>
        resolve({
          lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy,
          // Android exposes a mocked flag on the position; iOS omits it. The
          // duty heartbeat has carried this since Step 23 anti-fraud, so the ONE
          // lane where a manager deliberately asks must not be the one place a
          // spoofed position arrives unlabelled.
          mocked: (p as {mocked?: boolean}).mocked === true ? true : undefined,
        }),
      () => resolve(null),
      {
        ...ask,
        // VERBATIM from silentLocationFix — see the header note. Do not "improve"
        // `showLocationDialog` or `forceRequestLocation` without reading it.
        showLocationDialog: false,
        forceRequestLocation: true,
      },
    );
  });
}

/**
 * What the WORKER is told, for every outcome.
 *
 * Not only the happy one. The card the killed lane draws says "Tap to share
 * your location" and notifee's `autoCancel` removes it on the tap — so if the
 * share then fails, every trace of the request vanishes from the screen and the
 * worker is left believing they shared something they did not. Each outcome gets
 * a sentence, and the two that are the worker's to fix say what to do.
 *
 * The copy lives HERE rather than being imported from a screen: this module is
 * lazy-required from a headless JS VM and its module graph has to stay minimal.
 * The manager-facing wording of the same facts is `AssigneeRow`'s `REFUSE_COPY`;
 * the worker's durable version is `myPingOutcome` on My Attendance.
 */
export function announceCopy(
  outcome: PingResponseOutcome,
  reason?: 'no_permission' | 'no_fix' | 'off_shift' | 'expired',
): string | null {
  if (outcome === 'answered') {return 'Your manager requested your location — shared.';}
  if (outcome === 'duplicate') {
    // A duplicate is normally silence — there is nothing left to do. The one
    // exception is the worker TAPPING the card for a request the server has
    // already closed: they acted, so they get an answer.
    return reason === 'expired' ? 'This location request has expired.' : null;
  }
  if (outcome === 'failed') {
    return 'Couldn\'t share your location — open Attendance › Location requests.';
  }
  switch (reason) {
    case 'no_permission':
      return 'Your manager asked for your location — not shared, location permission is off.';
    case 'no_fix':
      return 'Your manager asked for your location — not shared, no location available.';
    case 'off_shift':
      return 'Your manager asked for your location — not shared, you were not clocked in.';
    default:
      return 'Your manager asked for your location — not shared.';
  }
}

/**
 * A toast, NOT an Alert: this can fire while the clock-in camera is open, and a
 * modal over the camera is the same intrusion the killed-app card avoids.
 */
function announce(
  outcome: PingResponseOutcome,
  reason?: 'no_permission' | 'no_fix' | 'off_shift' | 'expired',
): void {
  const msg = announceCopy(outcome, reason);
  if (!msg) {return;}
  try {
    const {Platform, ToastAndroid} = require('react-native') as typeof import('react-native');
    if (Platform.OS === 'android') {ToastAndroid.show(msg, ToastAndroid.LONG); return;}
    const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
    Alert.alert('Location request', msg);
  } catch {
    // A banner that cannot be drawn must never fail (or un-fail) the answer.
  }
}

/**
 * Answer one location ping, or say why not.
 *
 * Never throws. Four outcomes, and the caller branches on all four:
 *   · `'answered'`  — the server took a fix.
 *   · `'refused'`   — the server recorded a refusal (ours, or its own off-shift
 *                     verdict). Terminal either way.
 *   · `'duplicate'` — this id already has a terminal answer. NOT a failure:
 *                     there is nothing left to do and nothing to tell anyone.
 *   · `'failed'`    — nothing reached the server. The id is released so the
 *                     card's tap can retry.
 */
export async function respondToAttendancePing(
  pingId: string,
  opts?: {announce?: boolean},
): Promise<PingResponseOutcome> {
  if (!pingId) {return 'failed';}
  // Already settled — a second delivery of a question that has an answer.
  if (handled.has(pingId)) {return 'duplicate';}
  // Already being answered in this tick — the wake and the tap racing.
  if (inFlight.has(pingId)) {return 'duplicate';}
  inFlight.add(pingId);
  try {
    return await attempt(pingId, opts);
  } finally {
    // ALWAYS, on every exit path. A throw that latched this would kill the lane
    // for the life of the process.
    inFlight.delete(pingId);
  }
}

/**
 * The server's LAST WORD on a ping, or `null` if nothing was settled.
 *
 * 403 (not this device's ping), 404 (gone) and 409 (`ping_expired` /
 * `ping_not_pending`) cannot be changed by asking again. Everything else — no
 * response at all, a 5xx — is a TRANSPORT failure and stays retryable,
 * because the card the wake draws is this lane's only recovery path.
 *
 * Read structurally rather than through an imported AxiosError: this module is
 * lazy-required from a headless JS VM and its module graph has to stay minimal.
 */
function terminalRefusal(e: unknown): number | null {
  const status = (e as {response?: {status?: number}} | null)?.response?.status;
  return status === 403 || status === 404 || status === 409 ? status : null;
}

async function attempt(
  pingId: string,
  opts?: {announce?: boolean},
): Promise<PingResponseOutcome> {
  const {attendanceApi} = require('@services/api') as typeof import('@services/api');

  let permitted = false;
  try {
    permitted = await locationPermitted();
  } catch {
    permitted = false;
  }
  if (!permitted) {
    return refuse(attendanceApi, pingId, 'no_permission', opts);
  }

  let fix: {lat: number; lng: number; accuracy_m?: number; mocked?: boolean} | null = null;
  try {
    // B-866 — ONE retry, then the refusal. Sequential on purpose: a parallel
    // pair would take two fixes for one question whenever both landed, and the
    // whole point of the first ask is that it is usually free.
    fix = (await oneFix(FIRST_TRY)) ?? (await oneFix(RETRY));
  } catch {
    fix = null;
  }
  if (!fix) {
    return refuse(attendanceApi, pingId, 'no_fix', opts);
  }

  try {
    const {data} = await attendanceApi.answerPing(pingId, {
      lat: fix.lat, lng: fix.lng,
      ...(typeof fix.accuracy_m === 'number' ? {accuracy_m: Math.round(fix.accuracy_m)} : {}),
      // The KEY is omitted when the device said nothing, never sent as
      // `undefined`: an older server whitelists this body and a present-but-
      // empty field is the shape most likely to be rejected outright.
      ...(fix.mocked === true ? {mocked: true} : {}),
    });
    // The SERVER decides: a worker who clocked out between the ask and the
    // answer comes back 'refused', with the coordinates dropped, never stored.
    handled.add(pingId);
    const status: PingStatusDto | undefined = data?.ping?.status;
    const answered = status === 'answered';
    if (opts?.announce !== false) {
      // A server refusal here is its OFF-SHIFT verdict — the worker clocked out
      // between the ask and the answer, and the coordinates were dropped.
      announce(answered ? 'answered' : 'refused', answered ? undefined : 'off_shift');
    }
    return answered ? 'answered' : 'refused';
  } catch (e) {
    const terminal = terminalRefusal(e);
    if (terminal !== null) {
      // SETTLED server-side. Latch it exactly like an answer: the wake reads
      // 'failed' as "not handled" and draws a card whose tap re-acquires GPS,
      // which for a closed request is a location capture nobody is waiting on.
      handled.add(pingId);
      // 403 is "not yours to answer" — the worker did nothing and has nothing
      // to fix, so they are told nothing. A gone or dead request gets a line.
      if (opts?.announce !== false && terminal !== 403) {announce('duplicate', 'expired');}
      return 'duplicate';
    }
    // Nothing reached the server, so nothing is settled. The id is NOT marked
    // handled: the card the wake is about to draw has a tap, and that tap is
    // the only retry this lane has. The request expires on its own at 10 min.
    if (opts?.announce !== false) {announce('failed');}
    return 'failed';
  }
}

async function refuse(
  api: typeof import('@services/api')['attendanceApi'],
  pingId: string,
  reason: 'no_permission' | 'no_fix',
  opts?: {announce?: boolean},
): Promise<PingResponseOutcome> {
  try {
    await api.refusePing(pingId, reason);
    // The SERVER has it — terminal, exactly like an answer.
    handled.add(pingId);
    if (opts?.announce !== false) {announce('refused', reason);}
    return 'refused';
  } catch {
    if (opts?.announce !== false) {announce('failed');}
    return 'failed';
  }
}
