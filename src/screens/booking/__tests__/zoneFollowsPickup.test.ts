/**
 * B-861 — Secure Transfer "Build & confirm": the OPERATING ZONE tiles and the
 * Book Now / Book Later toggle are gone; the zone FOLLOWS the pick-up pin and
 * MISSION START is always shown.
 * Plan: `docs/planning/SECURE_TRANSFER_ZONE_SCHEDULE_PLAN_2026-09-11.md` (§10
 * A1–A13 authoritative).
 *
 * These are MONEY-FLOW RN screens the node `booking` project cannot import, so
 * they are read as source — same pattern as secureTransferDashboard /
 * coverageGate. Per CLAUDE.md: CRLF is normalised FIRST and comments are
 * stripped line-wise BEFORE any absence assertion (this file's own prose names
 * every banned token, and a `\n`-anchored regex would pass VACUOUSLY), and each
 * scan is anchored at the DECISION SITE rather than "somewhere in the file".
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {LAUNCHED_ZONES, LAUNCHED_ZONE_CODES, launchedZone, launchedZonesLabel} from '../launchedZones';

const ROOT = process.cwd();
const REVIEW = join('src', 'screens', 'booking', 'CustomizeAddOnsScreen.tsx');
const PICKER = join('src', 'screens', 'booking', 'LocationPickerScreen.tsx');
const ZONEMAP = join('src', 'screens', 'booking', 'ZoneMapScreen.tsx');

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

describe('the scans read real code', () => {
  it('are not vacuous', () => {
    for (const f of [REVIEW, PICKER, ZONEMAP]) {
      const src = code(f);
      expect(src.length).toBeGreaterThan(5_000);
      expect(src).not.toContain('\r');
    }
    // The stripper really removed comments (prose in these files names the
    // banned tokens below, so a broken stripper would flip every absence pin).
    expect(code(REVIEW)).not.toContain('founder 2026-09-11');
  });
});

describe('B-861 A5 — LAUNCHED_ZONES is the single source', () => {
  it('holds exactly the two launched zones, with their dispatch keys and clocks', () => {
    expect(LAUNCHED_ZONES.map(z => z.code)).toEqual(['AE', 'ZA']);
    expect([...LAUNCHED_ZONE_CODES]).toEqual(['AE', 'ZA']);
    // B-90 T-07 — South Africa DISPLAYS "SA" while its dispatch code stays ZA.
    expect(launchedZone('ZA')?.label).toBe('SA');
    expect(launchedZone('ZA')?.code).toBe('ZA');
    // B-789b — the clock every schedule picker reads in.
    expect(launchedZone('AE')?.utcOffsetHours).toBe(4);
    expect(launchedZone('ZA')?.utcOffsetHours).toBe(2);
    expect(launchedZone('SA')).toBeNull();
    expect(launchedZone(null)).toBeNull();
    expect(launchedZonesLabel()).toBe('UAE or South Africa');
  });

  it('ZoneMapScreen DERIVES its seed from it — the two lists cannot drift', () => {
    const zm = code(ZONEMAP);
    expect(zm).toMatch(/import \{LAUNCHED_ZONES\} from '\.\/launchedZones';/);
    expect(zm).toMatch(/const REGION_SEED: Region\[\] = LAUNCHED_ZONES\.map\(z => \(\{/);
    // The hand-written copies are gone from BOTH surfaces.
    expect(zm).not.toMatch(/\{code: 'AE', badge: 'UAE'/);
    expect(code(REVIEW)).not.toMatch(/\{code: 'AE', label: 'UAE'/);
  });

  it('the `zone_label` the two surfaces write is byte-identical', () => {
    // It becomes create()'s `region_label`, so a drift here renames the zone on
    // the ops console depending on which screen set it.
    expect(launchedZone('AE')?.name).toBe('UAE — Dubai, Abu Dhabi, Sharjah');
    expect(launchedZone('ZA')?.name).toBe('South Africa — Johannesburg, Cape Town');
  });
});

describe('B-861 A7 — ZoneMapScreen keeps its draft write', () => {
  it('handleContinue still stamps all four zone fields, including the clock', () => {
    // ZoneMap is the ENTRY of the whole Lite flow and the only writer of
    // `zone_utc_offset_hours` before a pin exists — it seeds the picker's
    // centre and the zone clock. Removing the tiles must not touch it.
    const zm = code(ZONEMAP);
    const cont = zm.slice(zm.indexOf('const handleContinue'), zm.indexOf('const cpoLabel'));
    expect(cont.length).toBeGreaterThan(150);
    expect(cont).toMatch(/if \(!selected\.available\) \{return;\}/);
    expect(cont).toMatch(/zone_code: selected\.code, zone_label: selected\.name, region: selected\.code,/);
    expect(cont).toMatch(/zone_utc_offset_hours: selected\.utcOffsetHours \?\? null,/);
    expect(cont).toMatch(/navigation\.navigate\('ServiceType'\)/);
  });
});

describe('B-861 A12 — which zone each picker accepts', () => {
  const review = code(REVIEW);
  const picker = code(PICKER);

  it('the PICK-UP picker gets the UNION list, led by the draft zone', () => {
    // A12.15 — Mapbox `country=` takes a list, and the HTML is keyed on the same
    // string, so 'AE,ZA' scopes the address search to both launched zones while
    // the draft's own zone still centres the map.
    //
    // P1-2 — the list is the UNION with the draft's own code, not the compiled
    // constant: ZoneMap's OP-04 path appends regions ops launched AFTER this
    // build, and dropping one here has the picker refuse the very zone the user
    // entered the flow through.
    expect(review).toMatch(
      /const zoneParamCodes = useMemo\(\s*\(\) => \[\.\.\.new Set\(\[draft\.zone_code, \.\.\.LAUNCHED_ZONE_CODES\]\.filter\(Boolean\)\)\],/);
    expect(review).toMatch(/const pickupZoneParam = zoneParamCodes\.join\(','\);/);
    // The SAME union gates the derivation, or the picker and the screen would
    // disagree about what is acceptable.
    expect(review).toMatch(/zoneFromPickup\(\s*\{lat: p\.pickedLat, lng: p\.pickedLng, country: p\.pickedCountry \?\? null\},\s*zoneParamCodes,/);
    expect(review).not.toMatch(/zoneFromPickup\([^)]*LAUNCHED_ZONE_CODES/);
    // The search scope is still derived from `countryCode`, never from the pin
    // (B-789a) — with the list that expression IS 'ae,za'.
    expect(picker).toMatch(/const country = countryCode\.toLowerCase\(\);/);
    expect(picker).toMatch(/\(scoped \? `&country=\$\{encodeURIComponent\(country\)\}` : ''\)/);
    // The map HTML is keyed on that same string.
    expect(picker).toMatch(/\}, \[countryCode\]\);/);
  });

  it('P1-2 — a live-added zone keeps the draft label and NEVER invents a clock', () => {
    const resolver = review.slice(review.indexOf('const zoneFieldsFor'), review.indexOf('useEffect(() => {', review.indexOf('const zoneFieldsFor')));
    expect(resolver.length).toBeGreaterThan(200);
    expect(resolver).toMatch(/const z = launchedZone\(code\);/);
    expect(resolver).toMatch(/const known = code === draft\.zone_code;/);
    expect(resolver).toMatch(/zone_label: known \? draft\.zone_label : code,/);
    // B-789b — a wrong offset books the wrong hour; `null` already means "use
    // the device clock", so an unknown zone must fall back to it, never guess.
    expect(resolver).toMatch(/zone_utc_offset_hours: known \? draft\.zone_utc_offset_hours : null,/);
  });

  it('A12.10 — the DROP-OFF picker is walled to the DERIVED zone, one code only', () => {
    // The server has NO drop-off region check, so this is the only cross-zone
    // wall. It must receive `draft.zone_code` (what the pick-up derived), never
    // the launched list — or a Johannesburg drop-off could ride a Dubai booking.
    expect(review).toMatch(/kind === 'pickup' \? pickupZoneParam : \(draft\.zone_code \|\| 'AE'\)/);
    // T-6 — and "accept any of these" is the caller's EXPLICIT intent, set only
    // by the pick-up. Inferring it from the list length made a one-zone
    // deployment fall back to the box-only arm, which cannot tie-break by
    // country at all.
    expect(review).toMatch(/\.\.\.\(kind === 'pickup' \? \{anyZone: true\} : null\),/);
    expect(picker).toMatch(/const anyZone = \(route\.params as \{anyZone\?: boolean\}\)\.anyZone === true;/);
    expect(picker).not.toMatch(/anyZone = zoneCodes\.length/);
    // ...and a caller that does NOT opt in keeps the unchanged single-zone arm.
    expect(picker).toMatch(/: isInsideRegionBox\(primaryCode, pin\.lat, pin\.lng\) !== false;/);
  });

  it('P2-10 — an empty-string country never travels as a country', () => {
    // A blank `short_code` from the map would otherwise be a truthy-looking
    // "geocode" that `zoneFromPickup` cannot use and cannot fall back from.
    expect(picker).toMatch(/country: msg\.country \|\| null,/);
    expect(picker).toMatch(/pickedCountry: pin\.country \|\| undefined,/);
    expect(picker).not.toMatch(/msg\.country \?\? null/);
    expect(picker).not.toMatch(/pin\.country \?\? undefined/);
  });
});

describe('B-861 A8 — the two self-heals adopt ONCE per pin', () => {
  const review = code(REVIEW);

  it('#1 the price board: adopt a served region that disagrees, once', () => {
    const heal = review.slice(review.indexOf('const pinKey ='), review.indexOf('const lastZoneOffsetRef'));
    expect(heal.length).toBeGreaterThan(300);
    expect(heal).toMatch(/const pinKey = draft\.pickup \? `\$\{draft\.pickup\.latitude\},\$\{draft\.pickup\.longitude\}` : null;/);
    expect(heal).toMatch(/if \(healedForPinKey\.current === pinKey\) \{return;\}/);
    expect(heal).toMatch(/healedForPinKey\.current = pinKey;/);
    // Only a region we actually serve is adopted — P1-2's union, so a live-added
    // zone heals too, and an unserved one is left for the refusal copy.
    expect(heal).toMatch(/if \(!zoneParamCodes\.includes\(pricedRegion\) \|\| pricedRegion === draft\.region\) \{return;\}/);
    expect(heal).toMatch(/const z = zoneFieldsFor\(pricedRegion\);/);
    // It MUST go through setPickupWithZone: a bare updateDraft({zone_code})
    // trips the store's zone-change hook and deletes the pin being healed.
    expect(heal).toMatch(/setPickupWithZone\(\{/);
    expect(heal).not.toMatch(/updateDraft\(\{\s*zone_code/);
    // P1-1 — the writer's answer is CONSUMED. Discarding it is how a drop-off
    // row empties itself with no explanation.
    expect(heal).toMatch(/const \{dropoffCleared\} = setPickupWithZone\(\{/);
    expect(heal).toMatch(/setDropoffNotice\(dropoffCleared \? z\.display : null\);/);
  });

  it('#2 the submit refusal: adopt `pickup_region`, once, then surface', () => {
    const back = review.slice(review.indexOf("msg?.code === 'pickup_outside_region'"));
    const branch = back.slice(0, back.indexOf('Booking failed'));
    expect(branch.length).toBeGreaterThan(200);
    expect(branch).toMatch(/const served = msg\.pickup_region && zoneParamCodes\.includes\(msg\.pickup_region\)/);
    expect(branch).toMatch(/if \(served && pinKey && healedForPinKey\.current !== pinKey\) \{/);
    expect(branch).toMatch(/healedForPinKey\.current = pinKey;/);
    expect(branch).toMatch(/const \{dropoffCleared\} = setPickupWithZone\(\{/);
    // P1-1 — the heal can clear the drop-off, and the CTA is blocked by
    // canAdvanceSchedule until it is back: the alert must say what to DO, not
    // send the founder to tap a disabled button.
    expect(branch).toMatch(/setDropoffNotice\(dropoffCleared \? healed\.display : null\);/);
    expect(branch).toMatch(/dropoffCleared\s*\?\s*'add the drop-off again, then confirm\.'/);
    expect(branch).toMatch(/:\s*'please confirm again\.'/);
  });

  /**
   * B-861 P2-2 / P2-9 (T-3) — when there is nothing to adopt (the server named
   * no region, or named one we do not serve, or this pin has already been
   * healed once), the user must be told what is actually wrong. "Booking
   * failed" is not actionable for a pin in the wrong country.
   */
  it('the REFUSAL arm names the wall instead of falling through to "Booking failed"', () => {
    const back = review.slice(review.indexOf("msg?.code === 'pickup_outside_region'"));
    const branch = back.slice(0, back.indexOf('activeId'));
    expect(branch.length).toBeGreaterThan(400);
    // The refusal is reached by the `served`/once-per-pin guard failing …
    expect(branch).toMatch(/if \(served && pinKey && healedForPinKey\.current !== pinKey\) \{/);
    // … and it alerts with the launched list, then returns — it never reaches
    // the generic handler below.
    expect(branch).toMatch(
      /Your pick-up is outside our operating zones — move the pin inside \$\{launchedZonesLabel\(\)\} and try again\./);
    expect(branch).toMatch(/'Outside our operating zones',/);
    const alertAt = branch.indexOf('Outside our operating zones');
    expect(branch.slice(alertAt)).toMatch(/return;/);
  });

  it('both heals share ONE ref, so the board and the submit cannot double-adopt', () => {
    expect((review.match(/healedForPinKey\.current = pinKey;/g) ?? []).length).toBe(2);
    expect((review.match(/const healedForPinKey = useRef/g) ?? []).length).toBe(1);
  });
});

/**
 * B-862 — RESOLVED 2026-09-12: the founder RETIRED the rule.
 *
 * "An active Pro member books NOW only" (founder 2026-08-26) was a CLIENT-only
 * product rule living on `BookingDateTimeScreen`, which nothing navigates to —
 * the live Secure Transfer screen is `CustomizeAddOnsScreen`, and neither it nor
 * the server ever enforced it. Asking about the Book Now / Book Later toggle the
 * founder said _"since for book later we can choose any date"_ and then asked
 * for every open item to be closed, so the clamp was DELETED rather than
 * promoted to the live screen.
 *
 * This block is kept, flipped: it now pins that NEITHER screen clamps. The
 * detail lives in `proNowOnlyBooking.test.ts`, which was this rule's own pin.
 */
describe('B-862 — the Pro now-only rule is retired on BOTH screens', () => {
  it('neither the legacy screen nor the LIVE one clamps a Pro member to now', () => {
    const legacy = code(join('src', 'screens', 'booking', 'BookingDateTimeScreen.tsx'));
    expect(legacy.length).toBeGreaterThan(2000);            // anti-vacuity
    expect(legacy).not.toMatch(/proActive/);
    expect(legacy).not.toMatch(/if \(proActive && mode === 'later'\)/);
    // The live screen never had it, and the retirement did not move it here.
    expect(code(REVIEW)).not.toMatch(/proActive/);
  });

  it('and nothing navigates to the legacy screen, so the rule is unreachable', () => {
    // Only the picker's DEFAULT return key names it, and every live caller
    // (Lite + all four Executive doors) passes its own `onPickRouteKey`.
    expect(code(PICKER)).toMatch(/\(onPickRouteKey \?\? 'BookingDateTime'\) as never/);
    expect(code(REVIEW)).toMatch(/onPickRouteKey: 'CustomizeAddOns'/);
  });
});

describe('B-861 A6 — a cleared drop-off is never silent', () => {
  const review = code(REVIEW);

  it('the writer reports the clear and the screen renders it', () => {
    expect(review).toMatch(/setDropoffNotice\(dropoffCleared \? z\.display : null\);/);
    expect(review).toMatch(/Drop-off cleared — the pick-up moved to \$\{dropoffNotice\}\. Add it again\./);
    // ...and it stops showing the moment a drop-off exists again.
    expect(review).toMatch(/\{dropoffNotice && !draft\.dropoff && \(/);
    expect(review).toMatch(/setDropoffNotice\(null\);/);
  });

  /**
   * P1-1 — EVERY writer of the zone consumes the answer. There are three
   * (the pick-up return and the two self-heals); one that discards it is a
   * drop-off row that empties itself in silence, which is exactly what A6
   * exists to prevent.
   */
  it('all THREE setPickupWithZone call sites consume {dropoffCleared}', () => {
    const calls = review.match(/setPickupWithZone\(\{/g) ?? [];
    expect(calls.length).toBe(3);
    const consuming = review.match(/const \{dropoffCleared\} = setPickupWithZone\(\{/g) ?? [];
    expect(consuming.length).toBe(3);
    // …and each one feeds the notice.
    expect((review.match(/setDropoffNotice\(dropoffCleared \?/g) ?? []).length).toBe(3);
  });
});

/**
 * B-874 (founder 2026-09-14) — FLIPPED from B-861 T-1 / P2-6.
 *
 * T-1 pinned the derived-lane PILL and its helper line ("Within 3 hours of
 * pick-up we dispatch immediately…"); P2-6 pinned the `auto_dispatch_enabled`
 * re-seed and the `startTouchedRef` that defended a chosen DAY from it. The
 * founder removed the bottom message and set ONE floor for every account —
 * "the app must simply not allow you to select a time less than 3 hours ahead"
 * — so the lane copy has nothing to say and the re-seed has nothing to re-seed
 * FOR. Both are deleted here, by every element they rendered or read: an effect
 * that can rewrite a start the user picked must not survive as dead weight.
 *
 * What REPLACES them is asserted positively: the derivation still runs (the
 * draft, the Summary row and the server all speak `booking_mode`) and the
 * ZONE-change re-seed, a different effect, is pinned in T-2 below.
 */
describe('B-874 — the derived-lane pill and the auto re-seed are both gone', () => {
  const review = code(REVIEW);

  it('no pill, no helper line, no lane copy anywhere in the wizard', () => {
    for (const sym of [
      'onDemandLaneOpen', 'derivedMode', 'bookingModeLabel',
      's.modeRow', 's.modePill', 's.modeHelp', 'modeRow:', 'modePill:', 'modeHelp:',
    ]) {
      expect(review).not.toContain(sym);
    }
    for (const phrase of [
      'On demand', 'Scheduled', 'dispatch immediately', 'Later times are scheduled',
      'of pick-up we dispatch',
    ]) {
      expect(review).not.toContain(phrase);
    }
    // POSITIVE CONTROL — the scan reads real code, so the absences mean something.
    expect(review).toContain('MISSION START TIME');
  });

  it('the auto re-seed effect and its touched-ref are gone', () => {
    expect(review).not.toContain('seededForAuto');
    expect(review).not.toContain('startTouchedRef');
    expect(review).not.toMatch(/\}, \[autoDispatch, zoneOffset\]\);/);
  });

  /**
   * P1-3 survives in the one place it still matters: the tick that used to move
   * the pill now keeps the DRAFT honest. Derived against `Date.now()` instead of
   * `nowTick` the effect would only re-run when some other state changed, and a
   * screen left open would file a start that has since fallen under the floor.
   */
  it('P1-3 — the draft mode is written against the 30 s tick, not a frozen clock', () => {
    expect(review).toMatch(/const nowTick = useNowTick\(\);/);
    expect(review).toMatch(/mode: deriveBookingMode\(startIso\.getTime\(\), nowTick\),/);
    expect(review).toMatch(/\}, \[computeStartTime, updateDraft, nowTick\]\);/);
    expect(review).not.toMatch(/mode: deriveBookingMode\(startIso\.getTime\(\), Date\.now\(\)\),/);
  });
});

/**
 * B-861 T-2 — the D3 / A12.11 zone-change re-seed runs through the pinned pure
 * rule, on the INSTANT the new zone's clock names (never the raw wall-clock ms,
 * which is the B-792 defect).
 */
describe('B-861 T-2 — the zone-change start re-seed', () => {
  const review = code(REVIEW);

  it('uses startNeedsReseed on the recomputed instant, and only on an offset change', () => {
    const effect = review.slice(review.indexOf('const lastZoneOffsetRef'), review.indexOf('const handleSubmit'));
    expect(effect.length).toBeGreaterThan(300);
    expect(effect).toMatch(/if \(lastZoneOffsetRef\.current === zoneOffset\) \{return;\}/);
    expect(effect).toMatch(/chosen\.setHours\(hour, minute, 0, 0\);/);
    // B-874 re-point: the floor handed to the shared rule is MIN_LEAD_HOURS for
    // every account — the ops-board `lead` local is gone.
    expect(effect).toMatch(
      /if \(!startNeedsReseed\(zoneWallClockToInstant\(chosen, zoneOffset\)\.getTime\(\), Date\.now\(\), MIN_LEAD_HOURS\)\) \{return;\}/);
    expect(effect).not.toMatch(/transferLeadHoursFor/);
    // The B-792 defect, verbatim: the wall-clock's own ms against a floor.
    expect(effect).not.toMatch(/chosen\.getTime\(\) </);
    // It re-seeds AND says so.
    expect(effect).toMatch(/setStartPick\(\{day: fixed, h: fixed\.getHours\(\), m: fixed\.getMinutes\(\)\}\);/);
    expect(effect).toMatch(/setLeadHint\(/);
  });
});
