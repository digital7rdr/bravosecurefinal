/**
 * PG-C4 (2026-09-02) — ONE runtime-permission prompt at a time.
 *
 * Both call screens request RECORD_AUDIO (+CAMERA, +BLUETOOTH_CONNECT) on
 * mount, and `getLocalMedia` (peerConnectionFactory) requests RECORD_AUDIO /
 * CAMERA again from inside the media boot. B-601's TURN prewarm removed the
 * ~300 ms that used to serialise the two, so on a FIRST-EVER call the second
 * `requestMultiple` was raised while the first dialog was still up — and
 * Android answers that with an empty result, which RN reports as DENIED.
 * Depending on which side lost: `getUserMedia` ran ungranted (the B-340
 * "device not available" failure) or the screen latched `permGranted =
 * 'denied'`, skipped the foreground service, and capture died on screen-off.
 *
 * Single-flight: a caller that finds a prompt in progress waits for it, then
 * re-checks and prompts only for what is STILL missing (usually nothing).
 * Already-granted permissions never prompt (Audit Step 2.3 kept).
 */
import {PermissionsAndroid, Platform} from 'react-native';

let inFlight: Promise<Record<string, string>> | null = null;

/** Test seam — the module latch must not leak across specs. */
export function __resetCallPermissionsForTests(): void {
  inFlight = null;
}

export async function requestCallPermissions(perms: readonly string[]): Promise<Record<string, string>> {
  const granted = (PermissionsAndroid.RESULTS?.GRANTED ?? 'granted') as string;
  if (Platform.OS !== 'android') {
    return Object.fromEntries(perms.map(p => [p, granted]));
  }
  const out: Record<string, string> = {};
  // Wait for any prompt already up, MERGING its answers: a permission the
  // other caller's dialog just settled (granted OR denied) is ANSWERED — the
  // user must not face a second dialog for it (PG-C4r, the ask-twice budget).
  // Loop: another waiter may have started a fresh prompt by the time this one
  // wakes.
  while (inFlight) {
    try {
      const prior = await inFlight;
      for (const p of perms) {
        if (prior[p] !== undefined && out[p] === undefined) {out[p] = prior[p];}
      }
    } catch { /* the other caller reports its own failure */ }
  }
  const unanswered = perms.filter(p => out[p] === undefined);
  if (unanswered.length === 0) {return out;}
  let pending: string[] = [...unanswered];
  try {
    const checks = await Promise.all(unanswered.map(p => PermissionsAndroid.check(p as never)));
    pending = unanswered.filter((_, i) => !checks[i]);
    unanswered.forEach((p, i) => { if (checks[i]) {out[p] = granted;} });
  } catch {
    // check() unsupported — prompt for everything (fail SAFE, B-340).
    pending = [...unanswered];
  }
  if (pending.length === 0) {return out;}
  const p = PermissionsAndroid.requestMultiple(pending as never)
    .then(res => ({...out, ...((res ?? {}) as Record<string, string>)}));
  inFlight = p;
  try {
    return await p;
  } finally {
    if (inFlight === p) {inFlight = null;}
  }
}
