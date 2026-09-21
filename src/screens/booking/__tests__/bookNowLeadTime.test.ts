/**
 * B-874 — ONE lead rule, and it is `MIN_LEAD_HOURS`.
 *
 * HISTORY, so nobody re-derives the reversed rule: E2E-10 made the picker floor
 * a PARAMETER because the server exempts an on-demand AUTO request from its lead
 * gate (`booking.service.ts` isOnDemandAuto) and ops seeded
 * `transfer_min_lead_hours` at 0.25 h. The founder REVERSED that on 2026-09-14:
 * "no need to indicate anything about dispatching immediately or 3 hours etc.
 * The app must simply not allow you to select a time less than 3 hours ahead."
 * So the ops-board lead, its four helpers and the derived-lane pill are gone
 * from the client, and every Secure Transfer files `'later'` by construction.
 * The SERVER is untouched — it still accepts `'now'` from other callers.
 *
 * Two halves are pinned here:
 *   1. the RULE (`MIN_LEAD_HOURS`, and the helpers that must stay deleted);
 *   2. the WIRING in CustomizeAddOnsScreen — a money-flow RN screen the node
 *      `booking` project cannot import, so it is read as source. Files are CRLF
 *      and carry prose naming these tokens, so comments are stripped line-wise
 *      first (a `\n`-anchored regex would pass VACUOUSLY — CLAUDE.md scan trap).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {MIN_LEAD_HOURS, startNeedsReseed} from '../scheduleGate';
import {setServicePricingOverrides} from '../servicePricingOverrides';

const ROOT = process.cwd();
const SCREEN = join('src', 'screens', 'booking', 'CustomizeAddOnsScreen.tsx');
const EXEC = join('src', 'screens', 'executive', 'ExecReviewScreen.tsx');

/** CODE only — CRLF-normalised, block + line comments stripped. */
function code(rel: string): string {
  const src = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

afterEach(() => setServicePricingOverrides(null));

describe('the scan reads real code', () => {
  it('is not vacuous', () => {
    const src = code(SCREEN);
    expect(src.length).toBeGreaterThan(8_000);
    expect(src).toContain('TEAM COMPOSITION');
    expect(src).not.toContain('\r');
  });
});

const NOW = Date.UTC(2026, 8, 14, 9, 0, 0);
const GATE = join('src', 'screens', 'booking', 'scheduleGate.ts');

describe('B-874 — ONE floor, and the ops board can no longer move it', () => {
  it('the floor is MIN_LEAD_HOURS, the server gate itself', () => {
    expect(MIN_LEAD_HOURS).toBe(3);
  });

  /**
   * The four helpers that encoded the reversed rule are DELETED, not merely
   * unused: a dead 15-minute floor sitting in `scheduleGate` is a trap for the
   * next maker, who would reach for it as "the transfer lead".
   */
  it('the ops-board Book-Now lead and its helpers are GONE from the client', () => {
    const gate = code(GATE);
    const screen = code(SCREEN);
    for (const sym of [
      'TRANSFER_MIN_LEAD_HOURS', 'transferMinLeadHours', 'transferLeadHoursFor',
      'leadHoursLabel', 'transfer_min_lead_hours',
    ]) {
      expect(gate).not.toContain(sym);
      expect(screen).not.toContain(sym);
    }
    // POSITIVE CONTROL — the scan can still see what IS there, so the absences
    // above are not a broken stripper or an unreadable file.
    expect(gate).toContain('export const MIN_LEAD_HOURS = 3;');
    expect(gate).toContain('export function deriveBookingMode');
  });

  /**
   * The BEHAVIOURAL half: an ops board that still carries the old key cannot
   * lower what the wizard accepts. `startNeedsReseed` is the floor check the
   * zone-change effect runs, and the screen hands it MIN_LEAD_HOURS (pinned as
   * source below), so a 15-minute-out start is refused.
   */
  it('a 15-minute-out start no longer clears the floor, whatever ops seeded', () => {
    setServicePricingOverrides({transfer_min_lead_hours: 0.25});
    expect(startNeedsReseed(NOW + 15 * 60_000, NOW, MIN_LEAD_HOURS)).toBe(true);
    expect(startNeedsReseed(NOW + 2 * 3600_000, NOW, MIN_LEAD_HOURS)).toBe(true);
    // Exactly ON the floor is bookable — the server's own gate is strictly `<`.
    expect(startNeedsReseed(NOW + MIN_LEAD_HOURS * 3600_000, NOW, MIN_LEAD_HOURS)).toBe(false);
  });
});

describe('B-874 — the wizard is wired to that one floor', () => {
  const src = code(SCREEN);

  it('the earliest-start helper is PARAMETERLESS and floors at MIN_LEAD_HOURS', () => {
    expect(src).toMatch(/function earliestStart\(\): Date \{/);
    expect(src).toMatch(/roundUpToMinuteStep\(new Date\(Date\.now\(\) \+ MIN_LEAD_HOURS \* 3600_000\), 5\)/);
    // The reversed E2E-10 shape, verbatim, and any surviving call that still
    // passes a lead in.
    expect(src).not.toMatch(/function earliestStart\(leadHours/);
    expect(src).not.toMatch(/earliestStart\([^)]/);
  });

  /**
   * B-874 — the floor no longer depends on the ACCOUNT. `autoDispatch` survives
   * for exactly one job (the location-consent gate); the count pin below is the
   * cheap way to notice it being reached for as a lead input again. If you add a
   * legitimate third use, update the number deliberately — do not delete the pin.
   */
  it('the floor is account-independent; autoDispatch is the CONSENT gate only', () => {
    expect(src).toMatch(/const earliest = instantToZoneWallClock\(earliestStart\(\), zoneOffset\)/);
    expect(src).not.toMatch(/const leadHours = /);
    expect(src).toMatch(/const autoDispatch = useAuthStore\(s => s\.user\?\.auto_dispatch_enabled === true\);/);
    expect(src).toMatch(/const consentRequired = autoDispatch;/);
    expect((src.match(/autoDispatch/g) ?? []).length).toBe(2);
  });

  it('B-861 — the MODE boundary is MIN_LEAD_HOURS, never the picker floor', () => {
    // The one line that must never be parameterised on the ops lead: below the
    // server's own 3 h gate a derived 'later' is refused; above it a derived
    // 'now' dispatches immediately against the user's wishes.
    const gate = code(join('src', 'screens', 'booking', 'scheduleGate.ts'));
    expect(gate).toMatch(
      /export function deriveBookingMode\(startMs: number, nowMs: number\): 'now' \| 'later' \{\s*return startMs - nowMs < MIN_LEAD_HOURS \* 3600_000 \? 'now' : 'later';/);
    expect(gate).not.toMatch(/deriveBookingMode[\s\S]{0,240}transferMinLeadHours\(/);
    // B-874 — the DERIVED LANE is no longer shown: with one 3 h floor every
    // bookable time is scheduled, so a pill could only ever read one word. The
    // derivation itself stays, because the draft, the Summary row and the server
    // all still speak `booking_mode` — it is written on the 30 s tick.
    expect(src).not.toMatch(/const derivedMode = /);
    expect(src).not.toMatch(/const onDemandLaneOpen = /);
    expect(src).not.toMatch(/onDemandLaneOpen/);
    expect(src).not.toMatch(/bookingModeLabel/);
    expect(src).toMatch(/mode: deriveBookingMode\(startIso\.getTime\(\), nowTick\),/);
    expect(src).toMatch(/\}, \[computeStartTime, updateDraft, nowTick\]\);/);
  });

  it('a Book-Now start UNDER the floor clamps up — it never rolls to tomorrow', () => {
    // The whole defect in one line: `start.setDate(start.getDate() + 1)`.
    expect(src).not.toMatch(/start\.setDate\(start\.getDate\(\) \+ 1\)/);
    const compute = src.slice(src.indexOf('const computeStartTime'), src.indexOf('const openPicker'));
    expect(compute.length).toBeGreaterThan(80);
    expect(compute).toMatch(/const floorMs = Date\.now\(\) \+ MIN_LEAD_HOURS \* 3600_000/);
    expect(compute).not.toMatch(/transferLeadHoursFor/);
    // The comparison is made on the ZONE instant of the picked wall-clock, and
    // the clamp target goes back into the zone frame — one exit, one clock.
    expect(compute).toMatch(/if \(zoneWallClockToInstant\(start, zoneOffset\)\.getTime\(\) < floorMs\) \{/);
    expect(compute).toMatch(/start = instantToZoneWallClock\(earliestStart\(\), zoneOffset\)/);
  });

  /**
   * B-874 — ONE field, ONE floor, ONE funnel. The time dropdown is the PLATFORM
   * clock and has no minimum on Android, so the sub-floor pick the founder said
   * the app "must simply not allow" is caught HERE and snapped UP to the
   * earliest bookable instant, which the hint names (never a silent other time).
   */
  it('the ONE commit funnel floors at MIN_LEAD_HOURS and auto-corrects', () => {
    const commit = src.slice(src.indexOf('const commitStart'), src.indexOf('const onStartDateChange'));
    expect(commit.length).toBeGreaterThan(120);
    expect(commit).toMatch(/Date\.now\(\) \+ MIN_LEAD_HOURS \* 3600_000/);
    expect(commit).toMatch(/earliestStart\(\)/);
    expect(commit).toMatch(/setLeadHint\(/);
    // The ops-board lead must not survive anywhere in the funnel.
    expect(commit).not.toMatch(/transferLeadHoursFor/);
    expect(commit).not.toMatch(/const lead = /);
    // The date dialog's floor is the same instant, in the zone's wall-clock
    // frame (B-791) — `earliest`, which is that expression, named once.
    expect(src).toMatch(/const earliest = instantToZoneWallClock\(earliestStart\(\), zoneOffset\)/);
    expect(src).toMatch(/minimumDate: earliest,/);
    expect(src).toMatch(/minimumDate=\{earliest\}/);
  });

  // B-826 — the founder removed the whole amber lead-time notice from the
  // SCHEDULE section ("just remove the full block that has text book now
  // dispatch immediately"). This pin ASSERTED the block existed; it is flipped
  // to assert it is gone, both branches. The Book Now / Book Later toggle above
  // it (and its "Earliest hh:mm" label) is a different element and stays.
  /**
   * B-826 kept: the founder's amber lead-time notice stays deleted, by every
   * string it had. B-861 FLIPS only the last two lines — the Book Now / Book
   * Later toggle the founder kept in B-826 is itself gone now ("remove the
   * operating zone and Book Now / Book Later", 2026-09-11), so the SCHEDULE
   * section must carry NEITHER label. The A1 helper line that replaces it is a
   * different element: one dim line beside a passive pill, never an
   * `s.alertWarn` card, and it quotes `MIN_LEAD_HOURS` (the mode boundary) —
   * `leadHoursLabel(leadHours)`, the picker floor the founder objected to
   * seeing, stays banned.
   */
  it('B-826/B-861/B-874 — banner, toggle AND the lane copy are all gone', () => {
    // B-861 P2-3 — the banned banner is asserted by VALUE, not by the spelling
    // of the expression that used to build it. The old
    // `not.toMatch(/leadHoursLabel\(leadHours\)/)` went vacuous the moment
    // `leadHours` stopped being the quoted number: it then passed whether or not
    // the banner existed. The strings below are what the founder actually
    // removed, and the amber CARD is what he removed it from.
    const BANNED_COPY = [
      'Minimum 3-hour lead time for all bookings',
      'Book Now dispatches immediately',
      'for all bookings',
    ];
    for (const phrase of BANNED_COPY) {
      expect(src).not.toContain(phrase);
    }
    expect(src).not.toMatch(/Minimum \{MIN_LEAD_HOURS\}-hour lead time/);
    expect(src).not.toMatch(/\{mode === 'now' && \(/);
    // B-861 — the slice runs to the end of the SCHEDULE section (the passenger
    // stepper), not to the first location row: with the toggle gone there are
    // only ~90 chars between the label and PICK-UP LOCATION, which would make
    // this scan vacuous on its own guard.
    // D6 — anchored on the SECTION, not on its label: the orphan SCHEDULE
    // label went with the toggle it used to head, and an anchor on deleted
    // markup slices an EMPTY string, which passes every absence pin below it.
    const schedule = src.slice(
      src.indexOf('<View style={s.schSection}>'), src.indexOf('>PASSENGERS<'));
    expect(schedule.length).toBeGreaterThan(1_500);
    // B-874 — the A1 helper line that replaced the amber card in B-861 is itself
    // gone now ("the bottom message doesn't make sense. Rather remove the bottom
    // message"), so the SCHEDULE section carries NEITHER element.
    expect(schedule).not.toContain('s.alertWarn');
    expect(schedule).not.toContain('s.modeHelp');
    expect(schedule).not.toContain('s.modeRow');
    expect(schedule).not.toContain('s.modePill');
    // …and the styles went with it, so nothing can quietly re-render them.
    expect(src).not.toContain('modeHelp:');
    expect(src).not.toContain('modeRow:');
    expect(src).not.toContain('modePill:');
    // B-861 — flipped: the toggle is gone from the section and from the screen.
    expect(src).not.toContain('Book Now');
    expect(src).not.toContain('Book Later');
    expect(src).not.toMatch(/s\.schToggle/);

    /**
     * B-874 — the whole-wizard RENDERED-COPY rule, stated by value. `src` is
     * comment-stripped, so a docblock that quotes the founder does not trip it;
     * a string the user can read does.
     */
    const B874_BANNED = [
      '3 hour', '3-hour', 'dispatch immediately', 'On demand', 'Scheduled',
      'from now', 'minutes of pick-up',
    ];
    for (const phrase of B874_BANNED) {
      expect(src).not.toContain(phrase);
    }
    // …and the copy that REPLACED the auto-correct hint is present, by value.
    expect(src).toContain("'Moved to the earliest available start · ' +");

    // POSITIVE CONTROL — the detector still catches the pre-fix shape. Without
    // this, every assertion above could be passing because the scan is broken
    // (a bad stripper, a CRLF-anchored regex, an empty slice).
    const PRE_FIX = [
      '  <View style={s.alertWarn}>',
      '    <Text>Minimum 3-hour lead time for all bookings</Text>',
      '    <Text style={s.schToggleT}>Book Now</Text>',
      '    <Text style={s.schToggleT}>Book Later</Text>',
    ].join('\n');
    for (const phrase of ['Minimum 3-hour lead time for all bookings', 'for all bookings']) {
      expect(PRE_FIX).toContain(phrase);
    }
    expect(PRE_FIX).toContain('s.alertWarn');
    expect(PRE_FIX).toContain('Book Now');
    expect(PRE_FIX).toContain('Book Later');
    expect(PRE_FIX).toMatch(/s\.schToggle/);
  });

  it('the resolved start is rendered, so a clamp is never silent', () => {
    expect(src).toMatch(/const nowStart = computeStartTime\(\)/);
    // B-789b — the RESOLVED line reads the zone's wall-clock (the picker's own
    // frame); `nowStart` stays the instant, and only the UTC stamp uses it raw.
    expect(src).toMatch(/const nowStartWall = instantToZoneWallClock\(nowStart, zoneOffset\)/);
    expect(src).toMatch(/Pick-up \{formatTime12h\(nowStartWall\.getHours\(\), nowStartWall\.getMinutes\(\)\)\}/);
    // D5 — a TIME-only stamp: the date beside it is the picker's own value,
    // and printing it twice in two formats is what the device showed.
    expect(src).toMatch(/\{fmtTimeUtc\(nowStart\)\}/);
    expect(src).not.toMatch(/fmtDateTimeUtc\(nowStart\)/);
  });

  /**
   * FLIPPED by B-874. The effect existed because /auth/me could land after mount
   * and flip the lead from 3 h to 15 min, leaving the field on a stale +3 h
   * seed. With one account-independent floor there is nothing to re-seed FOR,
   * and an effect that can rewrite a start the user chose is a liability — so it
   * is deleted, along with the `startTouchedRef` that existed only to defend
   * against it. The ZONE-change re-seed (B-861 T-2) is a different effect and
   * stays; it is pinned in zoneFollowsPickup.
   */
  it('the auto_dispatch re-seed effect is GONE, and so is its touched-ref', () => {
    expect(src).not.toMatch(/seededForAuto/);
    expect(src).not.toMatch(/startTouchedRef/);
    expect(src).not.toMatch(/\}, \[autoDispatch, zoneOffset\]\);/);
    // The zone-change re-seed survives, on MIN_LEAD_HOURS and without the flag.
    expect(src).toMatch(/const lastZoneOffsetRef = useRef\(zoneOffset\);/);
    expect(src).toMatch(
      /if \(!startNeedsReseed\(zoneWallClockToInstant\(chosen, zoneOffset\)\.getTime\(\), Date\.now\(\), MIN_LEAD_HOURS\)\) \{return;\}/);
    expect(src).toMatch(/\}, \[zoneOffset, startDay, hour, minute\]\);/);
  });
});

/**
 * B-792 — Book Later's commit is frame-mixed.
 *
 * `commitLater` receives a date off pickers that render the booking ZONE's days
 * and times (B-789b / B-791), so `snapped` is a WALL-CLOCK. Two halves each read
 * it as an instant:
 *
 *   1. the LEAD COMPARISON — `snapped.getTime() < Date.now() + 3 h` measures a
 *      foreign wall-clock by the device's clock. A Dubai phone (UTC+4) booking
 *      Cape Town (UTC+2) is 2 h out in the direction that ACCEPTS a pick under
 *      the lead, so the server refuses the create the wizard just cleared.
 *   2. the AUTO-CORRECT — `setLaterDate(earliestStart())` drops a raw INSTANT
 *      into the wall-clock `laterDate` slot, so the "earliest start" it offers
 *      is itself off by the offset, and the hint quotes that wrong hour.
 *
 * The EP twin (`ExecReviewScreen.commitLater`) was converted with B-791; this
 * one was missed, which is why the last case here pins BOTH screens: the defect
 * is the two drifting apart.
 */
// B-861 — `commitLater` is `commitStart`: one always-on MISSION START field has
// one commit funnel. The B-792 rule is unchanged and re-anchored on it.
describe('B-792 — the start commits in the zone frame, both halves', () => {
  const src = code(SCREEN);
  const commit = src.slice(src.indexOf('const commitStart'), src.indexOf('const onStartDateChange'));

  it('the scan reads the real commitStart (not a vacuous slice)', () => {
    expect(commit.length).toBeGreaterThan(120);
    expect(commit).toMatch(/roundUpToMinuteStep\(picked, 5\)/);
    expect(commit).toMatch(/setStartPick\(\{day: snapped, h: snapped\.getHours\(\), m: snapped\.getMinutes\(\)\}\);/);
  });

  it('the LEAD COMPARISON runs on the instant the wall-clock names', () => {
    expect(commit).toMatch(
      /zoneWallClockToInstant\(snapped, zoneOffset\)\.getTime\(\) < Date\.now\(\) \+ MIN_LEAD_HOURS \* 3600_000/);
    // The defect, verbatim: the raw wall-clock ms against an instant floor.
    expect(commit).not.toMatch(/snapped\.getTime\(\) < Date\.now\(\)/);
  });

  it('the AUTO-CORRECT seeds a zone wall-clock, never a raw instant', () => {
    expect(commit).toMatch(/const fixed = instantToZoneWallClock\(earliestStart\(\), zoneOffset\);/);
    // The defect, verbatim: an instant assigned into the wall-clock slot.
    expect(commit).not.toMatch(/const fixed = earliestStart\(/);
    // The 5-minute snap and a stated correction are untouched by this fix. B-874
    // re-points the COPY only: no hours, no "from now", no lane — the correction
    // names the date and time it moved to, which is what the founder asked for.
    expect(commit).toContain("'Moved to the earliest available start · ' +");
    expect(commit).not.toMatch(/Earliest start is/);
  });

  it('the EP twin stays converted too — the two screens must not drift again', () => {
    const execSrc = code(EXEC);
    const execCommit = execSrc.slice(
      execSrc.indexOf('const commitLater'), execSrc.indexOf('const onLaterDateChange'));
    expect(execCommit.length).toBeGreaterThan(120);
    expect(execCommit).toMatch(/zoneWallClockToInstant\(d, zoneOffset\)\.getTime\(\) < floor/);
    expect(execCommit).toMatch(/const fixed = instantToZoneWallClock\(earliestLater\(\), zoneOffset\);/);
    expect(execCommit).not.toMatch(/const fixed = earliestLater\(\);/);
  });
});
