/**
 * B-859 — the `attendance-ping` wake lane, end to end on the CLIENT side.
 *
 * `serverWakeKindParity` (booking project) proves the kind is covered by all
 * three maps, driven by the SERVER file. That scan is only as good as the server
 * commit landing: until it does, the client could ship the kind nowhere and
 * every assertion there would pass vacuously. These pin the CLIENT half
 * directly, and the details that parity cannot see — the channel, its
 * importance, the activity CLASS, and the answer-instead-of-a-card seam.
 *
 * Static source scans: these modules are the headless push path and the node
 * project cannot import them. Comments are STRIPPED first — this file's own
 * subject matter is quoted in the prose of every file it reads, which is
 * exactly how a scan passes vacuously.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const WAKE = code('src/modules/messenger/push/serverWakeNotifications.ts');
const BOOT = code('src/modules/messenger/push/fcmBootstrap.ts');
const SYNC = code('src/store/activitySync.ts');
const ACT  = code('src/screens/activity/ActivityCenterScreen.tsx');
const DEEP = code('src/navigation/messengerDeepLink.ts');

/** One `const NAME … };` map block, bounded so a sibling map cannot satisfy it. */
function mapBlock(src: string, name: string): string {
  const start = src.indexOf(`const ${name}`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n};', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('B-859 — the wake card', () => {
  it('has banner copy that names neither a manager nor a site (ids only on the wire)', () => {
    const meta = mapBlock(WAKE, 'AGENT_WAKE_META');
    const row = meta.split('\n').find(l => l.includes("'attendance-ping':")) ?? '';
    expect(row).not.toBe('');
    expect(row).toMatch(/title:\s*'Location requested'/);
    expect(row).toMatch(/asking where you are/);
    expect(row).toMatch(/sos:\s*false/);
  });

  it('rides its OWN channel at DEFAULT importance — a request, not an alert', () => {
    const meta = mapBlock(WAKE, 'AGENT_WAKE_META');
    const row = meta.split('\n').find(l => l.includes("'attendance-ping':")) ?? '';
    expect(row).toMatch(/channel:\s*'attendance-pings'/);
    expect(row).toMatch(/importance:\s*'default'/);
    // The channel needs a human NAME in the system settings list, or Android
    // shows it as "Updates" alongside every other fallback.
    expect(WAKE).toMatch(/'attendance-pings':\s*'Location requests'/);
    // …and the importance must actually reach BOTH createChannel and the
    // notification. An Android channel's importance is immutable after
    // creation, so a mismatch here ships for the life of the install.
    expect(WAKE).toMatch(/meta\.importance === 'default'\s*\?\s*AndroidImportance\.DEFAULT\s*:\s*AndroidImportance\.HIGH/);
    expect(WAKE).toMatch(/createChannel\(\{[\s\S]{0,200}importance,/);
    /**
     * The NOTIFICATION's own `android.importance`, anchored inside the
     * `displayNotification` block — not merely "the token appears somewhere".
     * Android takes the lower of the two, so leaving `AndroidImportance.HIGH`
     * hard-coded here does not make the channel loud, but it DOES make the two
     * disagree, and an OEM skin that reads the notification's value ships a
     * heads-up for a request that is meant to sit quietly in the shade.
     */
    const at = WAKE.indexOf('await notifee.displayNotification({\n        id: stableId,');
    expect(at).toBeGreaterThan(-1);
    const draw = WAKE.slice(at, WAKE.indexOf('});', at));
    expect(draw).toMatch(/android: \{[\s\S]*?\n\s*importance,\n/);
    expect(draw).not.toMatch(/importance: AndroidImportance\.HIGH/);
  });

  it('is an INCIDENT-class bell row — the class the server publishes it on', () => {
    // `attendance-*` has no prefix rule in kindToActivityClass, so it must be
    // listed; without it the wake records no durable row at all.
    expect(WAKE).toMatch(/if \(kind === 'attendance-ping'\) \{return 'incident';\}/);
    // …and the listing must come BEFORE the generic incident prefix test, or
    // it is unreachable dead code.
    expect(WAKE.indexOf("kind === 'attendance-ping'"))
      .toBeLessThan(WAKE.indexOf("kind.startsWith('incident')"));
  });

  it('has a bell-backfill row with no stale CTA', () => {
    const meta = mapBlock(SYNC, 'KIND_META');
    const row = meta.split('\n').find(l => l.includes("'attendance-ping':")) ?? '';
    expect(row).not.toBe('');
    expect(row).toMatch(/title:\s*'Location requested'/);
    // By the time this row is readable the app has already answered or refused,
    // so "Tap to share" would be a lie a day later.
    expect(row).not.toMatch(/Tap to share/);
  });
});

describe('B-859 — a RUNNING app answers instead of drawing a card', () => {
  it('the responder branch runs before every draw, and only with canRespond', () => {
    /**
     * Anchored INSIDE the executing function. `kindToActivityClass` above it
     * also tests `kind === 'booking-approved'`, so a whole-file `indexOf`
     * ordering assertion compares this branch against a sibling function and
     * reports a failure that has nothing to do with the draw order — the
     * `lastIndexOf` class of vacuous scan, one step along.
     */
    const at = WAKE.indexOf('export async function showServerWakeNotification');
    expect(at).toBeGreaterThan(-1);
    const body = WAKE.slice(at);
    expect(body).toMatch(/kind === 'attendance-ping' && opts\?\.canRespond && typeof data\.pingId === 'string'/);
    // BEFORE the booking-approved branch and the generic meta draw — otherwise
    // the worker gets a card they have to find and tap while the app is open.
    expect(body.indexOf("kind === 'attendance-ping' && opts?.canRespond"))
      .toBeLessThan(body.indexOf("kind === 'booking-approved'"));
    expect(body.indexOf("kind === 'attendance-ping' && opts?.canRespond"))
      .toBeLessThan(body.indexOf('const metaBase = AGENT_WAKE_META[kind]'));
  });

  /**
   * P1-1 — ONLY `'failed'` may fall through to the card.
   *
   * `'failed'` means nothing reached the server, so the card's tap is a live
   * retry (the responder releases the id for exactly that). `'duplicate'` is a
   * SECOND delivery of a question that already has an answer — drawing a card
   * there tells the worker to share a location they already shared, for a
   * request that no longer accepts one.
   */
  it('a duplicate delivery is HANDLED — it never draws a card', () => {
    const at = WAKE.indexOf('export async function showServerWakeNotification');
    const body = WAKE.slice(at);
    expect(body).toContain("if (outcome === 'duplicate') {return true;}");
    // …and it records nothing: the first delivery already minted the bell row.
    const branchAt = body.indexOf("kind === 'attendance-ping' && opts?.canRespond");
    const branch = body.slice(branchAt, body.indexOf("kind === 'booking-approved'"));
    expect(branch.indexOf("outcome === 'duplicate'"))
      .toBeLessThan(branch.indexOf('recordActivityForWake'));
  });

  it('the two APP-VM call sites pass canRespond; the KILLED one does not', () => {
    const calls = [...BOOT.matchAll(/showServerWakeNotification\([^)]*\)/g)].map(m => m[0]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {expect(c).toContain('canRespond: true');}
    // fcmHeadless is the killed-app lane: a GPS fix from a headless VM is
    // unreliable, so it draws the card instead.
    const HEADLESS = code('src/modules/messenger/push/fcmHeadless.ts');
    const headlessCalls = [...HEADLESS.matchAll(/showServerWakeNotification\([^)]*\)/g)].map(m => m[0]);
    expect(headlessCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of headlessCalls) {expect(c).not.toContain('canRespond');}
  });

  it('the card TAP answers, and navigates nowhere', () => {
    const at = BOOT.indexOf("} else if (kind === 'attendance-ping') {");
    expect(at).toBeGreaterThan(-1);
    const branch = BOOT.slice(at, BOOT.indexOf('} else if (', at + 10));
    expect(branch).toContain('respondToAttendancePing');
    // Yanking someone's app to another screen because a manager asked
    // something is the intrusion this lane exists to avoid.
    expect(branch).not.toContain('navigateToMessengerScreen');
    expect(branch).not.toContain('candidates =');
  });
});

describe('B-859 P1-4 — the bell row is not an incident', () => {
  it('paints a location pin, not the red incident octagon', () => {
    const kinds = mapBlock(ACT, 'KIND_META');
    expect(kinds).toMatch(/'attendance-ping':\s*\{icon:\s*'map-marker-radius-outline',\s*tint:\s*UI\.accentSoft\}/);
    // KIND beats CLASS, and the renderer must actually go through that helper.
    expect(ACT).toMatch(/KIND_META\[row\.kind\]/);
    expect(ACT).toMatch(/const meta = activityRowMeta\(r\)/);
    expect(ACT).not.toMatch(/const meta = CLASS_META\[r\.eventClass\]/);
  });

  it('a tap opens the worker\'s own attendance, NEVER MyIncidents', () => {
    expect(ACT).toMatch(/row\.kind === 'attendance-ping'[\s\S]{0,200}'MyAttendance'/);
    // …and it is checked BEFORE the incident fallback, whose id-less `else` arm
    // is MyIncidents — the wire class of a ping IS 'incident'.
    expect(ACT.indexOf("row.kind === 'attendance-ping'"))
      .toBeLessThan(ACT.indexOf("row.eventClass !== 'incident'"));
  });

  it('MyAttendance resolves per shell through the deep-link table (B-414)', () => {
    // A bare navigate to a route registered only inside the Departmental shell
    // is silently DROPPED in every other shell.
    expect(DEEP).toMatch(/DEPT_ATTEND_ROUTES[\s\S]{0,200}'MyAttendance'/);
    expect(DEEP).toMatch(/screen: 'Attend'/);
    // Attend-tab routes must be matched BEFORE the incident block, which has
    // its own tab nesting.
    expect(DEEP.indexOf('DEPT_ATTEND_ROUTES.has(target)'))
      .toBeLessThan(DEEP.indexOf('DEPT_INCIDENT_ROUTES.has(target)'));
  });
});
