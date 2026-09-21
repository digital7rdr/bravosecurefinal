/**
 * Wave 5 (PDF-2) sub-wave 5b — the 6-screen Secure Transfer wizard collapses
 * into ONE consolidated Booking dashboard, built by GROWING CustomizeAddOnsScreen
 * IN PLACE (it already owns confirmBooking + the credit-error call site + the
 * debounced server estimate). The earlier steps fold in as sections that write
 * the SAME bookingStore draft fields:
 *   - Zone     (from ZoneMapScreen)          → zone_code / zone_label / region
 *   - Schedule (from BookingDateTimeScreen)  → mode / passengers / pickup /
 *                                              dropoff / start_time, gated on
 *                                              canAdvanceSchedule; LocationPicker
 *                                              stays a pushed modal
 *   - Baseline (from BaselinePackageScreen)  → static hero, writes nothing
 *   - Team/add-ons/consent/brief/referral    → the CURRENT step-5 body, unchanged
 *   - Sticky CTA                             → the CURRENT confirmBooking() +
 *                                              status routing, verbatim
 *
 * This is a MONEY-FLOW screen the node `booking` project cannot import (RN
 * views), so it is pinned by reading the source — same pattern as
 * creditErrorCallSites / teamCellAlignment. Files are CRLF and carry design
 * prose that names these tokens, so comments are stripped line-wise first (a
 * `\n`-anchored regex would pass VACUOUSLY otherwise).
 */
import {readFileSync} from 'node:fs';
import {nextVehicleCount, vehiclesForPassengers} from '../pricing';
import {join} from 'node:path';

const ROOT = process.cwd();
const SCREEN = join('src', 'screens', 'booking', 'CustomizeAddOnsScreen.tsx');
const SERVICE_SCREEN = join('src', 'screens', 'booking', 'ServiceTypeScreen.tsx');

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

describe('the scan reads real code', () => {
  it('is not vacuous', () => {
    const src = code(SCREEN);
    expect(src.length).toBeGreaterThan(8_000);
    expect(src).toContain('TEAM COMPOSITION');
    expect(src).not.toContain('\r');
  });
});

/**
 * B-861 (SECURE_TRANSFER_ZONE_SCHEDULE_PLAN_2026-09-11 R1) — the OPERATING ZONE
 * section is GONE. Founder: "the operating zone will be chosen dynamically when
 * the user selects their pick-up location." Wave 5b's pins are FLIPPED, not
 * deleted: the invariant they defend — the same four draft fields are written,
 * from one place, and the location rows re-prompt when the zone moves — now
 * lives on `setPickupWithZone`.
 */
describe('B-861 — the zone FOLLOWS the pick-up (no zone tiles)', () => {
  const src = code(SCREEN);

  it('has no operating-zone section and no hand-picked zone tiles', () => {
    expect(src).not.toMatch(/OPERATING ZONE/);
    expect(src).not.toMatch(/const ZONES\b/);
    expect(src).not.toMatch(/selectZone/);
  });

  it('writes zone_code / zone_label / region / the CLOCK from the pin, in one call', () => {
    // The old tiles wrote three of the four fields and left zone_utc_offset_hours
    // stale (ZoneMapScreen wrote it, the tiles did not) — the store writer now
    // takes all four plus the pickup, so they can never drift apart again.
    expect(src).toMatch(/setPickupWithZone\(\{\s*zone_code:[^}]*zone_label:[^}]*region:[^}]*zone_utc_offset_hours:[^}]*pickup/);
    expect(src).toMatch(/const setPickupWithZone = useBookingStore\(st => st\.setPickupWithZone\)/);
  });

  it('derives the zone from the CONFIRMED pin, filtered to the launched set', () => {
    expect(src).toMatch(/zoneFromPickup\(/);
    expect(src).toMatch(/LAUNCHED_ZONE_CODES/);
  });

  it('still reads the live zone from the draft (the store owns the pickup/dropoff clear)', () => {
    // The store clears pickup/dropoff on a zone change; the pick-up row's
    // sub-label and the drop-off picker's scope both read draft.zone_code.
    expect(src).toMatch(/draft\.zone_code/);
  });
});

describe('5b — Schedule section (folded from BookingDateTimeScreen)', () => {
  const src = code(SCREEN);

  it('gates advancing on canAdvanceSchedule, reused verbatim', () => {
    expect(src).toContain('canAdvanceSchedule');
    expect(src).toContain('MIN_LEAD_HOURS');
  });

  it('the gate actually blocks the CTA AND short-circuits submit (not just present)', () => {
    // Edge review 5b: a presence-only pin would stay green if the guard were
    // deleted, letting a submit with a missing dropoff through. Pin the wiring.
    expect(src).toMatch(/scheduleReady\s*=\s*canAdvanceSchedule\(/);
    expect(src).toMatch(/ctaBlocked[^\n]*!scheduleReady/);
    expect(src).toMatch(/if\s*\(\s*!scheduleReady\s*\)\s*\{?\s*return/);
  });

  it('writes pickup, dropoff and start_time into the draft', () => {
    // B-861 — the PICK-UP goes through `setPickupWithZone` now (it carries the
    // zone the pin derived, and a bare `updateDraft({zone_code})` would trip the
    // store's clear and delete that very pin). The drop-off is unchanged.
    expect(src).toMatch(/setPickupWithZone\(\{[\s\S]{0,200}pickup,?\s*\}\)/);
    expect(src).toMatch(/updateDraft\(\{[^}]*dropoff:/);
    expect(src).toMatch(/start_time:/);
  });

  it('writes the DERIVED mode and the passenger count', () => {
    // B-861 — the Book Now / Book Later toggle is gone; `mode` is derived from
    // the chosen start and written by BOTH writers.
    //
    // T-4 — anchored inside `handleSubmit`, not merely "somewhere in the file".
    // The render-time effect writes the same pair, so a whole-file scan stayed
    // green even if SUBMIT stopped deriving — and submit is the one that files
    // the booking, picks the cancel policy and decides the dispatch lane.
    const submit = src.slice(src.indexOf('const handleSubmit'), src.indexOf('const selectedList'));
    expect(submit.length).toBeGreaterThan(300);
    expect(submit).toMatch(/const submitStart = computeStartTime\(\);/);
    expect(submit).toMatch(/mode: deriveBookingMode\(submitStart\.getTime\(\), Date\.now\(\)\),/);
    expect(submit).toMatch(/start_time: submitStart\.toISOString\(\),/);
    expect(submit).toMatch(/passengers,/);
    // The render-time effect keeps the draft current between submits.
    expect(src).toMatch(/updateDraft\(\{\s*start_time: startIso\.toISOString\(\),\s*mode: deriveBookingMode\(/);
    expect(src).not.toMatch(/updateDraft\(\{mode: 'now'\}\)/);
    expect(src).not.toMatch(/updateDraft\(\{mode: 'later'\}\)/);
  });

  /**
   * B-787 re-anchor. This pinned the LITERAL `Math.max(draft.vehicle_count,
   * minVehicles)`, which enforced the floor but could only ever raise the count
   * — a one-way ratchet: growing the party added a vehicle and shrinking it
   * again never took it away, so the client was charged for a vehicle the party
   * no longer needed. The INVARIANT this test exists for (the submitted count
   * never drops below what the passengers physically need) is unchanged and now
   * lives in `nextVehicleCount`, which is pinned both ways by
   * vehicleCountTwoWay.test.ts. The scan follows the rule; it is not relaxed.
   */
  it('keeps the passenger-derived vehicle floor (via nextVehicleCount)', () => {
    expect(src).toMatch(/nextVehicleCount\(\{/);
    // The floor itself is the rule's own guarantee, asserted directly.
    expect(nextVehicleCount({passengers: 10, chosen: 1, driverOnly: false}))
      .toBe(vehiclesForPassengers(10));
    // And the ratchet must not come back.
    expect(src).not.toMatch(/vehicle_count:\s*Math\.max\(/);
  });

  it('LocationPicker STAYS a pushed modal, returning to THIS dashboard route', () => {
    expect(src).toMatch(/navigation\.navigate\('LocationPicker'/);
    expect(src).toMatch(/onPickRouteKey:\s*'CustomizeAddOns'/);
  });

  it('merges the picked location back via the route params contract', () => {
    // Same {pickedAddress,pickedLat,pickedLng,pickedKind,pickedAt} merge as
    // BookingDateTimeScreen — the picker navigate({merge:true}) lands here.
    expect(src).toMatch(/route\.params/);
    expect(src).toMatch(/pickedKind/);
    expect(src).toMatch(/pickedLat/);
  });
});

/**
 * D4/D5/D6 — three things the 1.0.311 device pass found on this screen.
 */
describe('B-861 device pass — Build & confirm says each thing exactly once', () => {
  const src = code(SCREEN);

  /**
   * D4 — `colors` and `locations` must have the same length on EVERY
   * gradient, in every ternary ARM.
   *
   * The CTA passed a 2-colour BLOCKED palette beside a 3-stop `locations`,
   * and RN logged "colors and locations props should be arrays of the same
   * length" once per render — every 30 s once the B-861 clock tick started
   * re-rendering this screen. The gradient still DRAWS either way, so only a
   * check like this one catches it (the same class as the B-861
   * colour-stop-position trap, which is also log-only).
   */
  it('every LinearGradient with locations matches its colors length', () => {
    const tags = src.match(/<LinearGradient[\s\S]*?>/g) ?? [];
    expect(tags.length).toBeGreaterThan(2);
    /**
     * Array-literal lengths for one prop — one per ternary arm.
     *
     * TOP-LEVEL commas only: `rgba(7,9,13,0)` has three of its own, and
     * counting those reported a two-colour gradient as eight and made the
     * whole check noise.
     */
    const items = (arr: string): number => {
      const inner = arr.slice(1, -1).trim();
      if (!inner) {return 0;}
      let depth = 0;
      let n = 1;
      for (const ch of inner) {
        if (ch === '(' || ch === '[' || ch === '{') {depth += 1;}
        else if (ch === ')' || ch === ']' || ch === '}') {depth -= 1;}
        else if (ch === ',' && depth === 0) {n += 1;}
      }
      return n;
    };
    const arity = (tag: string, prop: string): number[] => {
      const i = tag.indexOf(prop + '={');
      if (i < 0) {return [];}
      const nl = tag.indexOf('\n', i);
      const seg = nl === -1 ? tag.slice(i) : tag.slice(i, nl);
      return (seg.match(/\[[^\]]*\]/g) ?? []).map(items);
    };
    const mismatched: string[] = [];
    for (const tag of tags) {
      const loc = arity(tag, 'locations');
      if (loc.length === 0) {continue;}
      for (const c of arity(tag, 'colors')) {
        if (!loc.includes(c)) {
          mismatched.push(`${c} colors vs ${loc.join('/')} locations in ${tag.slice(0, 90)}`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });

  /**
   * D5 — the resolved-start line printed the date TWICE: the date button's
   * own value and the date half of `fmtDateTimeUtc`. The UTC stamp is a
   * STAMP (the ops/CPO clock), so it keeps the time and drops the date.
   */
  it('the resolved start prints the date once and the UTC stamp is time-only', () => {
    // B-874 — RE-ANCHORED. The END anchor was `onDemandLaneOpen &&`, which the
    // pill deletion removed: `indexOf` would return −1, `slice` would run to one
    // char before the end, and every assertion below would read the WHOLE file
    // instead of this line. `{leadHint &&` is the next element and survives.
    const line = src.slice(src.indexOf('Pick-up {formatTime12h'), src.indexOf('{leadHint &&'));
    expect(line.length).toBeGreaterThan(60);
    expect(line.length).toBeLessThan(600);
    expect(line).toMatch(
      /toLocaleDateString\(undefined, \{weekday: 'short', day: '2-digit', month: 'short'\}\)/);
    expect(line).toMatch(/\{fmtTimeUtc\(nowStart\)\}/);
    expect(line).not.toMatch(/fmtDateTimeUtc/);
  });

  /**
   * D6 — the orphan "SCHEDULE" label. It headed the deleted Book Now / Book
   * Later segment; what follows it now is PICK-UP LOCATION, and MISSION
   * START carries its own header.
   */
  it('no bare SCHEDULE label sits above PICK-UP LOCATION', () => {
    expect(src).not.toMatch(/<Text style=\{s\.sectionLabel\}>SCHEDULE<\/Text>/);
    // The section itself is still there — only its orphaned label went.
    expect(src).toMatch(/label="PICK-UP LOCATION"/);
    expect(src).toMatch(/s\.schSection/);
  });
});

/**
 * B-873 / B-875 (founder 2026-09-14) — the two COPY changes, pinned by value at
 * the render site. `code()` strips comments, so a docblock quoting the founder
 * cannot make either of these pass.
 */
describe('B-873/B-875 — the founder copy on the wizard', () => {
  const src = code(SCREEN);

  it('B-873 — the comms add-on renders as ESCM, and the wire id is untouched', () => {
    expect(src).toContain("{key: 'comms',");
    expect(src).toContain("title: 'ESCM',");
    expect(src).toContain("desc: 'Electronic Surveillance Counter Measures',");
    // The retired copy, by value, both halves.
    expect(src).not.toContain('Comms / SIGINT');
    expect(src).not.toContain('Encrypted comms specialist');
    // The ID is the WIRE — renaming it would 400 create() with unknown_add_on.
    expect(src).not.toContain("{key: 'escm',");
  });

  it('B-875 — the approval notice says review, not an extra lead time', () => {
    const notice = src.slice(src.indexOf('{needsOpsApproval && ('), src.indexOf('OPTIONAL ADD-ONS'));
    expect(notice.length).toBeGreaterThan(200);
    expect(notice.length).toBeLessThan(900);
    // The card itself is unchanged (amber alert, same condition).
    expect(notice).toContain('s.alertWarn');
    expect(notice).toContain('Requests beyond the baseline (1 CPO + 1 Vehicle) are sent to the');
    expect(notice).toContain('<Text style={s.alertBold}>Bravo Control System</Text>');
    expect(notice).toContain('for review.');
    // The sentence the founder called out ("Why did you add 3 additional
    // hours? Maybe it could take longer.") is gone from the whole screen.
    expect(src).not.toContain('minimum 3-hour additional lead time');
    expect(src).not.toContain('additional lead time');
    expect(src).not.toContain('Bravo Control System approval');
    // The gate that decides WHEN it shows is untouched.
    expect(src).toMatch(/const needsOpsApproval = cpo_count > 1 \|\| \(!driver_only && vehicle_count > 1\);/);
  });
});

/**
 * B-877 (founder 2026-09-14, on the SERVICE DURATION card of a 10-minute
 * transfer: "What is this for? … This card is not relative." → "Confirm we can
 * set the 4 hours per region" — "Yes").
 *
 * A Secure Transfer is billed as a fixed BLOCK of hours ops set PER REGION, so
 * the wizard has no hours control for it at all. Hourly services keep the
 * stepper, which is why the card is GUARDED rather than deleted — and why the
 * whole card, including the "Billable time starts …" range note, has to sit
 * INSIDE the same guard (a note left outside would render 1–24 hours under a
 * transfer that cannot be stepped).
 */
describe('B-877 — a transfer has no SERVICE DURATION card', () => {
  const src = code(SCREEN);

  /**
   * The guarded slice: from `{!isTransfer && (` to the `)}` at ITS OWN JSX
   * indentation. Bounding it on the guard's close (rather than on the last
   * thing the card happens to contain) is what makes "the range note is inside
   * it" a real assertion — a note pushed out of the card falls outside this
   * slice instead of extending it.
   */
  function durationSlice(): string {
    const guard = src.indexOf('{!isTransfer && (');
    expect(guard).toBeGreaterThan(-1);
    const end = src.indexOf('\n        )}', guard);
    expect(end).toBeGreaterThan(guard);
    const slice = src.slice(guard, end);
    // A length guard: an anchor that drifts must fail, never pass vacuously.
    expect(slice.length).toBeGreaterThan(700);
    expect(slice.length).toBeLessThan(2_500);
    return slice;
  }

  it('the card and its range note are both inside the {!isTransfer && ( guard', () => {
    const slice = durationSlice();
    expect(slice).toContain('SERVICE DURATION');
    expect(slice).toContain('Billable time starts');
    expect(slice).toContain('setDurationHours(durationHours - 1)');
    expect(slice).toContain('durationRule.min');
    // Exactly one card, and no second unguarded copy anywhere on the screen.
    expect(src.split('SERVICE DURATION').length - 1).toBe(1);
    expect(src.split('Billable time starts').length - 1).toBe(1);
  });

  it('the block is the SERVER-quoted hours, mirror only until the reply lands', () => {
    expect(src).toContain("const isTransfer = draft.type === 'transfer';");
    expect(src).toMatch(/serverBlock \?\? transferBlockHours\(\)/);
    expect(src).toMatch(/setServerBlock\(data\.duration_hours\)/);
    // ONE source for the same field — no second subscription for draft.type.
    expect(src).toContain('const isHourly = !isTransfer;');
    expect(src).not.toMatch(/useBookingStore\(st => st\.draft\.type\)/);
  });

  it('the block is mirrored into the draft, so submit and Summary carry it', () => {
    const start = src.indexOf('if (isTransfer && draft.duration_hours !== durationHours)');
    expect(start).toBeGreaterThan(-1);
    const effect = src.slice(start, start + 200);
    expect(effect).toContain('updateDraft({duration_hours: durationHours})');
  });

  it('the total line still discloses the hours (it is the only disclosure left)', () => {
    expect(src).toContain('ESTIMATED TOTAL · {durationHours}H');
  });
});

describe('5b — Baseline section (folded from BaselinePackageScreen)', () => {
  const src = code(SCREEN);

  it('renders the static baseline hero (writes nothing to the draft)', () => {
    expect(src).toMatch(/BASELINE PACKAGE/);
    expect(src).toContain('BASE_RATE_BC');
  });
});

// ── PRESERVED from the current step 5 (must stay green — regression pins) ──────
describe('5b — the submit path is the step-5 confirmBooking(), verbatim', () => {
  const src = code(SCREEN);

  it('still calls confirmBooking and keeps the exact status routing', () => {
    expect(src).toContain('confirmBooking()');
    expect(src).toContain("'DISPATCHING'");
    expect(src).toContain("navigation.navigate('FindingDetail'");
    expect(src).toContain("'NO_PROVIDER'");
    expect(src).toContain("navigation.navigate('NoDetail'");
    expect(src).toContain('navigation.popToTop()');
    expect(src).toContain("navigation.navigate('OpsRoomReview'");
  });

  it('still routes a short balance to CreditPaywall via the ONE shared rule', () => {
    const start = src.indexOf('isInsufficientCreditsError(e)');
    expect(start).toBeGreaterThan(-1);
    const branch = src.slice(start, src.indexOf('return;', start));
    expect(branch).toContain("navigation.navigate('CreditPaywall'");
    expect(branch).toContain("source: 'booking-flow'");
    expect(branch).not.toContain('Alert.alert');
  });

  it('the escrow total is still the server estimate (no money math moved)', () => {
    expect(src).toContain('estimatePrice');
    expect(src).toMatch(/estimated_price:\s*totalBc/);
  });
});

describe('5b — routing: Secure Transfer card points at the dashboard', () => {
  it('ServiceTypeScreen navigates to CustomizeAddOns, not BookingDateTime', () => {
    const src = code(SERVICE_SCREEN);
    expect(src).toMatch(/navigation\.navigate\('CustomizeAddOns'\)/);
    expect(src).not.toMatch(/navigation\.navigate\('BookingDateTime'\)/);
    // The Lite-only guard is untouched.
    // B-785 — the gate is the local PICK (any bookable card, executive included).
    expect(src).toContain('if (!canContinue) {return;}');
  });

  it('pins the booking type on Continue (a pre-selected transfer needs a drop-off)', () => {
    // The Secure Transfer card is pre-selected, so a user can proceed WITHOUT
    // tapping it. handleContinue must re-pin type from the service, else `type`
    // stays 'timeslot' and canAdvanceSchedule stops requiring a drop-off.
    const src = code(SERVICE_SCREEN);
    // B-785 — pinned from the local pick, which is what the card taps write.
    expect(src).toMatch(/updateDraft\(\{\s*service: picked,\s*type:\s*bookingTypeFor\(picked\)/);
  });
});
