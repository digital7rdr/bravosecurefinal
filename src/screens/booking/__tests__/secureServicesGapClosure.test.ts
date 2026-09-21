/**
 * "Secure Services Streamlined" (client UX spec, Wave 5) — the four client-
 * visible gaps a read-only audit found after the one-dashboard consolidation:
 *
 *   GAP 1  a compact 12-HOUR time dropdown in FIVE-MINUTE steps on BOTH
 *          dashboards (Secure Transfer Book Now + Book Later; Executive start
 *          time + transfer pickup time), every displayed time 12-hour, Book
 *          Later snapped UP to 5 min and never under the 3-hour lead.
 *   GAP 2  the ">24 h → Bravo Secure Pro" nudge lost when ExecDurationScreen
 *          was folded into the Executive dashboard.
 *   GAP 3  "Base Protection" + "Secure Transfer" subtotals above the Executive
 *          Estimated Total (the arithmetic is pinned in execPriceSummary.test).
 *   GAP 4  the Lite card left the plan chooser (founder D3) — BookingHome's
 *          plan-card copy + a11y label must not still say "Lite".
 *
 * Both dashboards are MONEY-FLOW screens the node `booking` project cannot
 * import (RN views), so — same as secureTransferDashboard /
 * execProtectionDashboard — they are pinned by reading the source. Files are
 * CRLF and carry design prose naming these tokens, so comments are stripped
 * line-wise first (a `\n`-anchored regex would pass VACUOUSLY otherwise).
 *
 * The money paths (draft shape, confirmBooking payload, 3-hour lead, pricing)
 * are re-pinned here as ABSENCE-OF-CHANGE checks: the picker UI and the display
 * format were the only things allowed to move.
 */
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const TRANSFER = join('src', 'screens', 'booking', 'CustomizeAddOnsScreen.tsx');
const EXEC = join('src', 'screens', 'executive', 'ExecReviewScreen.tsx');
const HOME = join('src', 'screens', 'booking', 'BookingHomeScreen.tsx');
const WHEEL = join('src', 'components', 'booking', 'WheelTimePicker.tsx');
const FIELD = join('src', 'components', 'booking', 'TimeDropdownField.tsx');
const NAVIGATOR = join('src', 'navigation', 'BookingNavigator.tsx');

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

const count = (src: string, needle: string): number => src.split(needle).length - 1;

// The 24-hour display formula both dashboards used: `${pad(d.getHours())}:${pad(d.getMinutes())}`.
const HOUR24_DISPLAY = /pad\([^)]*getHours\(\)\)\s*\}?\s*:/;

describe('the scans read real code', () => {
  it('are not vacuous', () => {
    for (const rel of [TRANSFER, EXEC, HOME, WHEEL]) {
      const src = code(rel);
      expect(src.length).toBeGreaterThan(2_000);
      expect(src).not.toContain('\r');
    }
    expect(code(TRANSFER)).toContain('TEAM COMPOSITION');
    expect(code(EXEC)).toContain('confirmBooking');
  });
});

// ── GAP 1 — the 12-hour / 5-minute time dropdown ──────────────────────────────
describe('GAP 1 — WheelTimePicker grows a 12-hour cycle (AM/PM column)', () => {
  const src = code(WHEEL);

  it('exposes hourCycle and renders an AM/PM column in 12-hour mode', () => {
    expect(src).toMatch(/hourCycle/);
    expect(src).toMatch(/'AM'/);
    expect(src).toMatch(/'PM'/);
    // 1..12, not 0..23, for the hour column in 12-hour mode.
    expect(src).toMatch(/length:\s*12/);
  });

  it('converts through the shared 12h helpers (no second copy of the arithmetic)', () => {
    expect(src).toMatch(/from '\.\/time12h'/);
    expect(src).toMatch(/\bto12h\(/);
    expect(src).toMatch(/\bto24h\(/);
  });

  it('keeps the 24-hour default so BookingDateTimeScreen (the other caller) is unchanged', () => {
    expect(src).toMatch(/hourCycle\s*=\s*24/);
  });
});

describe('GAP 1 — TimeDropdownField: a dropdown FIELD that opens the 12-hour wheel', () => {
  it('exists', () => {
    expect(existsSync(join(ROOT, FIELD))).toBe(true);
  });

  const src = existsSync(join(ROOT, FIELD)) ? code(FIELD) : '';

  // B-646 r3 — the hand-rolled wheel is GONE; the field opens the PLATFORM picker.
  // Founder call after the wheel cost three separate bugs (rail swallowing drags,
  // disabled interval momentum killing flicks, an unmemoised prop re-scrolling it).
  // The 12-hour rule from B-615 survives — it is now the OS clock's own AM/PM UI.
  it('reads as a dropdown (chevron) and opens the NATIVE picker, not a hand-rolled wheel', () => {
    expect(src).toMatch(/chevron-down/);
    expect(src).not.toMatch(/<WheelTimePicker/);
    // Android: imperative, never a mounted component (see androidPicker.ts).
    expect(src).toMatch(/openAndroidTimePicker\(\{/);
    expect(src).toMatch(/is24Hour: false/);
    // iOS has no modal time dialog, so it keeps the native spinner in a sheet.
    expect(src).toMatch(/<Modal/);
    expect(src).toMatch(/<DateTimePicker[\s\S]{0,200}mode="time"/);
    expect(src).toMatch(/display="spinner"/);
  });

  it('enforces the minute step itself, since the native clock has no interval on Android', () => {
    expect(src).toMatch(/export function snapToStep/);
    // Rounds TOTAL minutes and wraps the day, so 11:58 at step 5 is 12:00 — never
    // 11:60, and never hour 24.
    expect(src).toMatch(/\(hour \* 60 \+ minute\)/);
    expect(src).toMatch(/% 1440/);
    expect(src).toMatch(/const snapped = snapToStep\(h, m, minuteStep\);/);
  });

  it('labels the field with the shared 12-hour formatter', () => {
    expect(src).toMatch(/formatTime12h\(/);
  });

  it('commits on Done and still hands the caller a 24-hour hour (the draft shape is untouched)', () => {
    expect(src).toMatch(/Done/);
    expect(src).toMatch(/onChange\(/);
    // The field never formats its own value into the callback — it passes the wheel's 24h hour.
    expect(src).not.toMatch(/onChange\(\s*formatTime12h/);
  });
});

describe('GAP 1 — Secure Transfer dashboard (CustomizeAddOnsScreen)', () => {
  const src = code(TRANSFER);

  /**
   * B-861 (SECURE_TRANSFER_ZONE_SCHEDULE_PLAN_2026-09-11 R2, A10) — the Book Now
   * / Book Later toggle is gone and MISSION START is ALWAYS rendered, so there
   * is ONE time field, not two branches with one each. The GAP-1 rule the pin
   * defends (the time is the 12-hour dropdown, never a native time picker or the
   * inline 24-hour wheel) is unchanged; the count flips 2 → exactly 1.
   */
  it('the ONE always-on time field is the dropdown (no native time picker, no 24-hour wheel)', () => {
    expect(src).toMatch(/from '@components\/booking\/TimeDropdownField'/);
    expect(count(src, '<TimeDropdownField')).toBe(1);
    expect(src).not.toMatch(/<WheelTimePicker/);
    expect(src).not.toMatch(/is24Hour/);
    expect(src).not.toMatch(/mode="time"/);
    expect(src).not.toMatch(/mode=\{pickerMode\}/);
    // MISSION START is not behind a branch any more: no mode ternary renders it.
    expect(src).toMatch(/<Text style=\{s\.fieldLabel\}>MISSION START<\/Text>/);
    expect(src).not.toMatch(/\{mode === 'now' \? \(/);
  });

  it('the native DATE picker stays, with its lead-time floor', () => {
    expect(src).toMatch(/<DateTimePicker[\s\S]{0,200}mode="date"/);
    // B-791 (Lite twin) - the dialog shows ZONE wall-clock days, so its floor is
    // converted into that frame. B-861 names that instant once (`earliest`) and
    // floors on the APPLICABLE lead, so an on-demand booking can still be today.
    expect(src).toMatch(/const earliest = instantToZoneWallClock\(earliestStart\(\), zoneOffset\)/);
    expect(src).toMatch(/minimumDate=\{earliest\}/);
  });

  it('every displayed time is 12-hour — the 24-hour formula is gone', () => {
    expect(src).toMatch(/formatTime12h\(/);
    expect(src).not.toMatch(HOUR24_DISPLAY);
    // B-826 removed the lead-time alert; B-861 removed the toggle that carried
    // the "Earliest …" sub-label. The surviving display is the resolved pick-up
    // line, plus the auto-correct hint inside the commit funnel.
    expect(src).toMatch(/Pick-up \{formatTime12h\(/);
    expect(src).toMatch(/formatTime12h\(fixed\.getHours\(\), fixed\.getMinutes\(\)\)/);
    expect(src).not.toMatch(/earliest\{' '\}\s*\n?\s*\{formatTime12h\(/);
  });

  it('the start snaps UP to 5 minutes and never lands under the applicable lead', () => {
    expect(src).toMatch(/roundUpToMinuteStep\(/);
    const commit = src.slice(src.indexOf('const commitStart'), src.indexOf('const onStartDateChange'));
    expect(commit.length).toBeGreaterThan(50);
    expect(commit).toMatch(/roundUpToMinuteStep\(/);
    // B-874 re-point: ONE floor for every account, so the funnel names
    // MIN_LEAD_HOURS directly instead of asking for the account's lead.
    expect(commit).not.toMatch(/transferLeadHoursFor/);
    expect(commit).toMatch(/Date\.now\(\) \+ MIN_LEAD_HOURS \* 3600_000/);
    // All THREE entry points (iOS spinner, Android dialog, time pick) funnel
    // through the one commit — the Android dialog is the one B-643 made
    // imperative, so it has its own callback and must not bypass the funnel.
    expect(src).toMatch(/onStartDateChange[\s\S]{0,400}commitStart\(/);
    expect(src).toMatch(/const onStartTimeChange[\s\S]{0,200}commitStart\(/);
    expect(src).toMatch(/onPicked: d => \{[\s\S]{0,200}commitStart\(next\);/);
    expect(src).toMatch(/<TimeDropdownField[\s\S]{0,400}onChange=\{onStartTimeChange\}/);
  });

  it('MONEY PATH UNCHANGED — start_time, draft writes and the submit payload are byte-verbatim', () => {
    expect(src).toMatch(/start\.setHours\(hour, minute, 0, 0\);/);
    /**
     * E2E-10 + B-789b re-anchor. This pinned the LITERAL
     * `if (start.getTime() < Date.now() + MIN_LEAD_HOURS * 3600_000) {`, i.e.
     * the rule that pushed ANY Book-Now start under `now + 3 h` to TOMORROW.
     * That rule was the bug: the server EXEMPTS an on-demand auto request from
     * the lead gate (`booking.service.ts` isOnDemandAuto) and ops seeds
     * `transfer_min_lead_hours` at 0.25 h, so the headline "guard now" product
     * could not be booked from this wizard at all — every immediate request
     * silently became a next-day reservation.
     *
     * The INVARIANT this test exists for is unchanged and is asserted directly
     * below: a start is never emitted under the floor that applies. B-874
     * (founder 2026-09-14) REVERSES which floor that is — the ops-board
     * `transferLeadHoursFor` lead is gone and MIN_LEAD_HOURS applies to every
     * account — but the CLAMP is untouched: a sub-floor pick still moves UP to
     * the earliest bookable instant, never forward a day. Both directions stay
     * pinned by bookNowLeadTime.test.ts.
     *
     * B-789b supplies the CLOCK FRAME, not the floor: the comparison is made on
     * the ZONE instant of the picked wall-clock, never the device reading of it.
     * Same rule, right clock — and the clamp target is converted back into the
     * zone frame, so the single `zoneWallClockToInstant` exit stays honest.
     */
    expect(src).not.toMatch(/transferLeadHoursFor/);
    expect(src).toMatch(/const floorMs = Date\.now\(\) \+ MIN_LEAD_HOURS \* 3600_000;/);
    expect(src).toMatch(/if \(zoneWallClockToInstant\(start, zoneOffset\)\.getTime\(\) < floorMs\) \{/);
    expect(src).toMatch(/start = instantToZoneWallClock\(earliestStart\(\), zoneOffset\);/);
    expect(src).not.toMatch(/start\.setDate\(start\.getDate\(\) \+ 1\)/);

    // B-861 — the submit names the instant ONCE, because the derived
    // `booking_mode` must describe the SAME start that goes on the wire. Same
    // single source (`computeStartTime()`), one call instead of two.
    expect(src).toMatch(/const submitStart = computeStartTime\(\);/);
    expect(src).toMatch(/start_time: submitStart\.toISOString\(\),/);
    expect(src).toMatch(/mode: deriveBookingMode\(submitStart\.getTime\(\), Date\.now\(\)\),/);
    expect(src).toMatch(/updateDraft\(\{selected_add_ons: selectedList, estimated_price: totalBc\}\);/);
    expect(src).toContain('const booking = await confirmBooking();');
    // B-787 re-anchor: the submit payload still pins a vehicle count that
    // respects the passenger floor, but through the shared two-way rule instead
    // of `Math.max(draft.vehicle_count, minVehicles)` — that expression could
    // only RAISE the count, so a party that grew and shrank again was booked
    // (and escrow-charged) for a vehicle it no longer needed. Pinned both
    // directions by vehicleCountTwoWay.test.ts.
    expect(src).toMatch(/vehicle_count: nextVehicleCount\(\{passengers, chosen: chosenVehiclesRef\.current, driverOnly: driver_only\}\),/);
  });
});

describe('GAP 1 — Executive dashboard (ExecReviewScreen)', () => {
  const src = code(EXEC);

  it('start time AND transfer pickup time use the dropdown field; the native TIME pickers are gone', () => {
    expect(src).toMatch(/from '@components\/booking\/TimeDropdownField'/);
    expect(count(src, '<TimeDropdownField')).toBeGreaterThanOrEqual(2);
    expect(src).not.toMatch(/is24Hour/);
    expect(src).not.toMatch(/mode="time"/);
    expect(src).not.toMatch(/mode=\{pickerMode\}/);
  });

  it('the native DATE picker stays, floored by the CONFIGURED lead time', () => {
    expect(src).toMatch(/<DateTimePicker[\s\S]{0,200}mode="date"/);
    // execMinLeadHours(), not a hardcoded 3 — ops can change exec_min_lead_hours.
    // B-791 - the iOS spinner shows ZONE wall-clock days, so its floor is converted into that frame.
    expect(src).toMatch(/minimumDate=\{instantToZoneWallClock\(new Date\(Date\.now\(\) \+ execMinLeadHours\(\) \* 3600_000\), zoneOffset\)\}/);
  });

  it('every displayed time is 12-hour — the 24-hour formula is gone', () => {
    expect(src).toMatch(/formatTime12h\(/);
    expect(src).not.toMatch(HOUR24_DISPLAY);
    // startLabel feeds "Same as start time (…)"; the lead alert names the earliest time.
    expect(src).toMatch(/const startLabel = formatTime12h\(/);
    expect(src).toMatch(/Same as start time \(\$\{startLabel\}\)/);
    expect(src).toMatch(/is\{' '\}\s*\n?\s*\{formatTime12h\(live/);
  });

  it('the start pick snaps UP to 5 minutes and keeps the reject-and-correct lead rule', () => {
    const commit = src.slice(src.indexOf('const commitLater'), src.indexOf('const onLaterDateChange'));
    expect(commit.length).toBeGreaterThan(50);
    expect(commit).toMatch(/roundUpToMinuteStep\(/);
    expect(commit).toMatch(/Date\.now\(\) \+ lead \* 3600_000/);
    expect(commit).toMatch(/execMinLeadHours\(\)/);
    expect(commit).toMatch(/earliestLater\(\)/);
    expect(commit).toMatch(/setLeadError\(/);
    expect(src).toMatch(/onLaterDateChange[\s\S]{0,400}commitLater\(/);
    expect(src).toMatch(/const onLaterTimeChange[\s\S]{0,200}commitLater\(/);
    expect(src).toMatch(/<TimeDropdownField[\s\S]{0,400}onChange=\{onLaterTimeChange\}/);
  });

  it('the transfer pickup time still resolves through the B-382 window resolver', () => {
    // B-789b re-anchor: still the B-382 resolver, now fed the ZONE wall-clock of
    // the start and converted back to an instant for the draft.
    expect(src).toMatch(/resolveTransferTime\(instantToZoneWallClock\(startDate, zoneOffset\), durationH, h, m\)/);
    expect(src).toMatch(/zoneWallClockToInstant\([\s\S]{0,160}resolveTransferTime/);
    expect(src).toContain('transferTimeOutOfWindow');
    // And the "reset to start time" door survives the field swap.
    expect(src).toMatch(/accessibilityLabel="Reset to same as start time"/);
    expect(src).toMatch(/updateDraft\(\{transport_pickup_time: ''\}\)/);
  });

  it('MONEY PATH UNCHANGED — start_time write, estimate, escrow total and submit are byte-verbatim', () => {
    // `mode` became the literal 'later' (EP is always scheduled, 2026-08-31);
    // everything downstream of it - estimate, escrow total, submit payload - is
    // deliberately byte-identical, which is what the rest of this test pins.
    expect(src).toMatch(/updateDraft\(\{mode: 'later', start_time: start\.toISOString\(\), \.\.\.transferRebase\}\);/);
    expect(src).toMatch(/const totalBc = serverTotal \?\? execTotalBc\(localRate, hours\);/);
    expect(src).toMatch(/updateDraft\(\{selected_add_ons: selectedAddOnIds, estimated_price: totalBc\}\);/);
    expect(src).toContain('const booking = await confirmBooking();');
    expect(src).toMatch(/service: 'executive_protection'/);
  });
});

// ── GAP 2 — the ">24 h → Bravo Secure Pro" nudge ──────────────────────────────
describe('GAP 2 — the Pro nudge lives under the DURATION grid on the Executive dashboard', () => {
  const src = code(EXEC);

  it('mirrors the old ExecDurationScreen copy + target', () => {
    expect(src).toContain('Need cover for longer than 24 hours?');
    expect(src).toMatch(/Explore Bravo Secure Pro for Long-Term Bookings\./);
    expect(src).toMatch(/navigation\.navigate\('SecureServices'\)/);
    // The old wizard step was DELETED (2026-08-31, always-scheduled change) once
    // it had been unreachable for months, so it can no longer be the wording
    // mirror. The dashboard IS the single source now, asserted above.
  });

  it('sits directly under the DURATION grid, before the SCHEDULE section', () => {
    const grid = src.indexOf('EXEC_DURATIONS.map(');
    const nudge = src.indexOf('Need cover for longer than 24 hours?');
    const schedule = src.indexOf('SCHEDULE · START TIME');
    expect(grid).toBeGreaterThan(-1);
    expect(nudge).toBeGreaterThan(grid);
    expect(schedule).toBeGreaterThan(nudge);
  });

  it('is a real button (role + label), and the route exists in the booking stack', () => {
    expect(src).toMatch(/accessibilityLabel="Need cover for longer than 24 hours\? Explore Bravo Secure Pro"/);
    expect(code(NAVIGATOR)).toMatch(/name="SecureServices"/);
  });
});

// ── GAP 3 — Base Protection / Secure Transfer subtotals ───────────────────────
describe('GAP 3 — the Executive price summary shows both subtotals above the total', () => {
  const src = code(EXEC);

  it('derives the lines + subtotals from the ONE pure helper (no second pricing copy)', () => {
    expect(src).toMatch(/from '\.\/execPriceSummary'/);
    expect(src).toMatch(/execPriceLines\(/);
    expect(src).toMatch(/execPriceSummary\(lines, hours\)/);
  });

  it('renders "Base Protection" always and "Secure Transfer" only with transport on, both above the total', () => {
    const card = src.slice(src.indexOf('<Text style={s.fieldLabel}>CALCULATION</Text>'), src.indexOf('ESTIMATED TOTAL'));
    expect(card.length).toBeGreaterThan(100);
    expect(card).toMatch(/>Base Protection</);
    expect(card).toMatch(/\{hasTransport && \([\s\S]{0,400}>Secure Transfer</);
    expect(card).toMatch(/Math\.round\(baseBc\)/);
    expect(card).toMatch(/Math\.round\(transferBc\)/);
  });

  it('the total row is untouched (server estimate first, local mirror second)', () => {
    expect(src).toMatch(/\{Math\.round\(totalBc\)\} BC/);
    expect(src).toMatch(/ESTIMATED TOTAL\{serverTotal === null \? ' \(EST\.\)' : ''\}/);
  });
});

// ── GAP 4 — "Lite" left the plan chooser ──────────────────────────────────────
describe('GAP 4 — BookingHome plan card no longer advertises Lite', () => {
  const src = code(HOME);

  it('copy and a11y label name Pro + Bravo Secure Lux only', () => {
    expect(src).toContain('Secure plans: Pro & Bravo Secure Lux.');
    expect(src).toContain('secure plans Pro and Bravo Secure Lux');
    expect(src).not.toMatch(/secure plans[^"'\n]*Lite/i);
    expect(src).not.toMatch(/Secure plans:[^<\n]*Lite/);
  });
});
