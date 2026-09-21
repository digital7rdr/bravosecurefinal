/**
 * B-776 — static wiring pins for the receive-side foreground hold.
 *
 * No test drives the real productionRuntime.ts receive with NativeModules,
 * and fcmBootstrap.ts / fcmHeadless.ts are not imported by tests, so the call
 * sites are pinned by source scan (comments stripped, CRLF-safe, anchored
 * INSIDE the closure that executes — see CLAUDE.md source-scan traps).
 *
 *  1. The socket lane: `handleDeliver` acquires the envelope, THEN holds the
 *     FGS with reason 'ws', and releases both in its `finally`.
 *  2. The HTTP drain (`coalescedDrain` — reconnect / resume / chat-open
 *     kicks) holds 'drain' and releases in its `finally` (critic F6).
 *  3. The warm wake: the `msg-wake` branch holds 'warm-wake' before any await
 *     and releases in a `finally`; the HTTP pull waits for the in-flight set.
 *  4. The killed wake: the `msg-wake` branch holds 'headless-wake' and
 *     releases in a `finally`.
 *  5. The native half exists and is declared: the dataSync permission, the
 *     service with foregroundServiceType="dataSync", exported=false, its own
 *     MIN-importance channel, the Android 15 onTimeout, the package registered
 *     in MainApplication AND in the prebuild plugin list (critic F4).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Strip block and line comments so prose can never satisfy a code assertion. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}

function slice(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(endMarker, a + startMarker.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('B-776 receive-hold wiring (source scans)', () => {
  it('socket lane: handleDeliver holds after the envelope acquire and releases both in finally', () => {
    const src = stripComments(read('src/modules/messenger/runtime/productionRuntime.ts'));
    const fn = slice(src, 'async function handleDeliver(frame: ServerEnvelopeDeliver', 'async function handleDeliverInner(');
    const acquire = fn.indexOf('tryAcquireEnvelope(envId)');
    const hold = fn.indexOf("holdReceiveForeground('ws')");
    const inner = fn.indexOf('await handleDeliverInner(frame, deps)');
    const fin = fn.indexOf('finally');
    expect(acquire).toBeGreaterThan(-1);
    expect(hold).toBeGreaterThan(acquire);      // never hold for a 'busy' duplicate
    expect(inner).toBeGreaterThan(hold);        // held BEFORE the decrypt starts
    expect(fin).toBeGreaterThan(inner);
    const finallyBody = fn.slice(fin);
    expect(finallyBody).toMatch(/releaseEnvelope\(envId, hold\)/);
    expect(finallyBody).toMatch(/releaseRecvFg\(\)/);
  });

  it('HTTP drain: coalescedDrain holds \'drain\' before drainPump and releases in its finally', () => {
    const src = stripComments(read('src/modules/messenger/runtime/productionRuntime.ts'));
    const fn = slice(src, 'const coalescedDrain = (): Promise<void> => {', 'void transport.connect()');
    const hold = fn.indexOf("holdReceiveForeground('drain')");
    const pump = fn.indexOf('return drainPump().finally(');
    expect(hold).toBeGreaterThan(-1);
    expect(pump).toBeGreaterThan(hold);
    expect(fn.slice(pump)).toMatch(/releaseRecvFg\(\)/);
  });

  it('warm wake: the msg-wake branch holds before its first await, releases in finally, and waits for the socket lane before pulling', () => {
    const src = stripComments(read('src/modules/messenger/push/fcmBootstrap.ts'));
    const handler = slice(src, 'messaging().setBackgroundMessageHandler(async (remoteMessage) =>', '\n});');
    const branch = slice(handler, "} else if (data.kind === 'msg-wake') {", 'showServerWakeNotification');
    const hold = branch.indexOf("holdReceiveForeground('warm-wake')");
    const firstAwait = branch.indexOf('await ');
    expect(hold).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(hold);
    expect(branch).toMatch(/finally \{\s*releaseRecvFg\(\);\s*\}/);
    const wait = branch.indexOf('waitForNoInFlightEnvelopes(WAKE_PULL_INFLIGHT_WAIT_MS)');
    const pull = branch.indexOf('.pullEnvelopes(); pulled = true;');
    expect(wait).toBeGreaterThan(-1);
    expect(pull).toBeGreaterThan(wait);
    expect(src).toMatch(/const WAKE_PULL_INFLIGHT_WAIT_MS = 3_000;/);
  });

  it('killed wake: the msg-wake branch holds before its first await and releases in finally', () => {
    const src = stripComments(read('src/modules/messenger/push/fcmHeadless.ts'));
    // The server-wake dispatch is the first code after the msg-wake block.
    const branch = slice(src, "if (kind === 'msg-wake') {", 'showServerWakeNotification');
    const hold = branch.indexOf("holdReceiveForeground('headless-wake')");
    const firstAwait = branch.indexOf('await ');
    expect(hold).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(hold);
    expect(branch).toMatch(/finally \{\s*releaseRecvFg\(\);\s*\}/);
  });

  it('native half: dataSync permission + typed, unexported service on its own MIN channel + package registered in MainApplication AND the prebuild plugin', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toMatch(/android:name="android\.permission\.FOREGROUND_SERVICE_DATA_SYNC"/);
    const svc = manifest.match(/<service[^>]*android:name="\.MessageSyncForegroundService"[^>]*\/>/);
    expect(svc).not.toBeNull();
    expect(svc![0]).toMatch(/android:exported="false"/);
    expect(svc![0]).toMatch(/android:foregroundServiceType="dataSync"/);
    const main = read('android/app/src/main/java/com/bravosecure/app/MainApplication.kt');
    expect(main).toMatch(/add\(BravoMessageSyncPackage\(\)\)/);
    const plugin = read('plugins/withBravoAndroidPackages.js');
    expect(plugin).toMatch(/'BravoMessageSyncPackage'/);
    const service = read('android/app/src/main/java/com/bravosecure/app/MessageSyncForegroundService.kt');
    expect(service).toMatch(/FOREGROUND_SERVICE_TYPE_DATA_SYNC/);
    expect(service).toMatch(/FOREGROUND_SERVICE_DEFERRED/);
    expect(service).toMatch(/CHANNEL_ID = "bravo-messages-sync-silent"/);
    expect(service).toMatch(/IMPORTANCE_NONE/); // rev5 — silenced: full priority, no card
    expect(service).toMatch(/MessageSyncJobService\.scheduleExpedited\(/); // refusal → job fallback
    expect(service).toMatch(/override fun onTimeout\(startId: Int, fgsType: Int\)/);
    expect(service).toMatch(/@Volatile\s+var running/);
    const mod = read('android/app/src/main/java/com/bravosecure/app/BravoMessageSyncModule.kt');
    expect(mod).toMatch(/getName\(\): String = "BravoMessageSync"/);
    expect(mod).toMatch(/stopService\(/); // stop never delivers a start intent from the background
    // rev5 — service first on every API level; the job is the refusal fallback.
    expect(mod).toMatch(/MessageSyncJobService\.finishOrCancel\(/);
    const job = read('android/app/src/main/java/com/bravosecure/app/MessageSyncJobService.kt');
    expect(job).toMatch(/class MessageSyncJobService : JobService\(\)/);
    expect(job).toMatch(/\.setExpedited\(true\)/);
    expect(job).toMatch(/ReactInstanceProbe\.isAlive/); // a swiped-away app must not resurrect for a stale hold
    const jobSvc = manifest.match(/<service[^>]*android:name="\.MessageSyncJobService"[^>]*\/>/);
    expect(jobSvc).not.toBeNull();
    expect(jobSvc![0]).toMatch(/android:permission="android\.permission\.BIND_JOB_SERVICE"/);
    expect(jobSvc![0]).toMatch(/android:exported="false"/);
  });
});
