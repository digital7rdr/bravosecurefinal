/**
 * B-868 — the ENTRY of the booking flow stops asking for an operating zone.
 *
 * Founder 2026-09-11: "remove the operating zone and Book Now / Book Later;
 * instead the operating zone will dynamically be chosen when the user selects
 * their pick-up location." B-861 removed the zone TILES from the Secure
 * Transfer build screen; `ZoneMapScreen` was still the hand-picked zone step at
 * the HEAD of the flow, and two header chips still advertised "Change region".
 *
 * What this pins:
 *   D1  the Book CTA on `SecureServicesScreen` opens ServiceType, not ZoneMap.
 *   D2  the header region chips (BookingHome, ProDashboard) are INFORMATIONAL —
 *       a View, no press handler, an a11y label that NAMES the zone.
 *   D3  `ZoneMapScreen` is a read-only coverage EXPLORER under `explore`: no
 *       draft write, a "Done" CTA that goes back. Without the param the legacy
 *       write survives (persisted nav state can still land there).
 *   D5  the EXECUTIVE service location derives the zone from its own pin.
 *   D6  no surface invites the user to CHOOSE a zone any more.
 *
 * These are RN screens the node `booking` project cannot import, so they are
 * read as SOURCE — same pattern as `zoneFollowsPickup` / `coverageGate`. Per
 * CLAUDE.md: CRLF is normalised FIRST, comments are stripped line-wise BEFORE
 * any absence assertion (this file's own prose names every banned token, and a
 * `\n`-anchored regex would pass VACUOUSLY), and each scan is anchored at the
 * DECISION SITE rather than "somewhere in the file".
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();

const HOME     = join('src', 'screens', 'booking', 'BookingHomeScreen.tsx');
const ZONEMAP  = join('src', 'screens', 'booking', 'ZoneMapScreen.tsx');
const PRO      = join('src', 'screens', 'pro', 'ProDashboardScreen.tsx');
const PLANS    = join('src', 'screens', 'securepro', 'SecureServicesScreen.tsx');
const TYPES    = join('src', 'navigation', 'types.ts');
const EXECREV  = join('src', 'screens', 'executive', 'ExecReviewScreen.tsx');
const EXECTASK = join('src', 'screens', 'executive', 'ExecTaskScreen.tsx');
const EXECTRAN = join('src', 'screens', 'executive', 'ExecTransportScreen.tsx');
const STORE    = join('src', 'store', 'bookingStore.ts');

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

describe('B-868 — the scans read real code', () => {
  it('are not vacuous', () => {
    for (const f of [HOME, ZONEMAP, PRO, PLANS, TYPES, EXECREV, EXECTASK, EXECTRAN, STORE]) {
      const src = code(f);
      expect(src.length).toBeGreaterThan(2_000);
      expect(src).not.toContain('\r');
    }
    /**
     * P2-1 — these anchors are LOAD-BEARING and were decorative before: both
     * referenced strings that do not exist in the shipped files, so replacing
     * `code()` with the identity function left the whole suite green. Each
     * entry below is a comment that IS in its file today and MUST be gone after
     * stripping, paired with a code token that must SURVIVE it — a stripper
     * that eats too much is as dangerous as one that eats nothing (the
     * source-scan-stripper-eats-code class).
     */
    const stripped: Array<[file: string, comment: string, keptCode: string]> = [
      [ZONEMAP, 'B-868 — the explorer writes NOTHING', 'const explore = route.params?.explore === true;'],
      [HOME, 'B-660 - on a narrow screen the flag alone carries the region', 'const zoneChip = zoneChipCopy(zonePinned, chipRegion);'],
      [PRO, 'B-868 — INFORMATIONAL, same treatment as BookingHome', 'const zoneChip = zoneChipCopy(zonePinned, chipRegion);'],
      [STORE, 'DERIVED, never re-typed', 'const SEED_ZONE = LAUNCHED_ZONES[0];'],
      [EXECREV, 'executive transfer legs are their OWN fields', 'const {zoneChanged} = setPickupWithZone({'],
    ];
    for (const [file, comment, keptCode] of stripped) {
      // The comment exists in the RAW file …
      expect(readFileSync(join(ROOT, file), 'utf8')).toContain(comment);
      // … and the stripper removed it …
      expect(code(file)).not.toContain(comment);
      // … while leaving the real code alone.
      expect(code(file)).toContain(keptCode);
    }
  });
});

describe('B-868 D1 — the Book CTA skips the zone step', () => {
  it('SecureServicesScreen opens ServiceType and never names ZoneMap', () => {
    const src = code(PLANS);
    // The `lite` arm of openPlan is the decision site.
    const open = src.slice(src.indexOf('const openPlan'), src.indexOf('const openPlan') + 900);
    expect(open.length).toBeGreaterThan(300);
    // NAV-10 — the forward tap guard, because this arm now STARTS a booking.
    expect(open).toMatch(/if \(key === 'lite'\) \{\s*navigateOnce\(navigation, 'ServiceType'\);/);
    expect(src).not.toMatch(/navigate\('ZoneMap'\)/);
  });

  it('ProDashboardScreen never names ZoneMap either', () => {
    expect(code(PRO)).not.toMatch(/navigate\('ZoneMap'\)/);
    expect(code(PRO)).not.toMatch(/navigateOnce\(navigation, 'ZoneMap'/);
  });
});

describe('B-868 D2 / D6 — the header region chip is informational', () => {
  /**
   * Anchored the way `coverageGate` anchors the picker's chip: find the STYLE
   * the chip is opened with, then read backwards to the element that opens it.
   * A window-sized slice would happily swallow the neighbouring bell's onPress
   * and pass (or fail) for the wrong reason.
   */
  function chipOpenTag(src: string, styleToken: string): string {
    const at = src.indexOf(styleToken);
    expect(at).toBeGreaterThan(-1);
    const open = src.lastIndexOf('<', at);
    // P2-6 — slice forward to the tag's own `>` as well. Stopping at the style
    // prop made the scan depend on ATTRIBUTE ORDER: moving `accessibilityLabel`
    // ahead of `style` would have hidden it from every assertion below, and
    // moving `accessible` after it would have produced a spurious RED.
    const close = src.indexOf('>', at);
    expect(close).toBeGreaterThan(open);
    return src.slice(open, close + 1);
  }

  it('BookingHome: a View, not a Touchable, and it NEVER asserts the seed', () => {
    const src = code(HOME);
    const openTag = chipOpenTag(src, 'style={styles.regionBtn}');
    // `[\s>]`, not a bare space: the open tag may legitimately wrap onto
    // several lines, and a space-anchored regex would fail on formatting alone.
    expect(openTag).toMatch(/^<View[\s>]/);
    expect(openTag).toMatch(/\baccessible\b/);
    expect(openTag).not.toMatch(/TouchableOpacity|Pressable/);
    // P1-1 — the copy comes from the shared, unit-pinned rule …
    expect(src).toMatch(/const zonePinned = useBookingStore\(s => s\.draft\.pickup !== null\);/);
    expect(src).toMatch(/const zoneChip = zoneChipCopy\(zonePinned, chipRegion\);/);
    expect(openTag).toMatch(/accessibilityLabel=\{zoneChip\.a11y\}/);
    expect(src).toMatch(/>\{zoneChip\.text\}</);
    // … and the two things that NAME one country are gated on a derived zone.
    expect(src).toMatch(/\{zonePinned\s*\?\s*<Text style=\{styles\.flagText\}>\{chipRegion\.flag\}<\/Text>/);
    expect(src).not.toMatch(/accessibilityLabel=\{`Operating zone: \$\{chipRegion\.name\}`\}/);
    expect(src).not.toMatch(/>\{chipRegion\.badge\}</);
    // The invitation to choose is gone from the label AND from the glyph that
    // advertised a menu.
    expect(src).not.toMatch(/Change region/);
  });

  it('ProDashboard: the same chip, the same rule', () => {
    const src = code(PRO);
    const openTag = chipOpenTag(src, 'style={s.regionBtn}');
    expect(openTag).toMatch(/^<View[\s>]/);
    expect(openTag).toMatch(/\baccessible\b/);
    expect(openTag).not.toMatch(/TouchableOpacity|Pressable/);
    expect(src).toMatch(/const zonePinned = useBookingStore\(st => st\.draft\.pickup !== null\);/);
    expect(src).toMatch(/const zoneChip = zoneChipCopy\(zonePinned, chipRegion\);/);
    expect(openTag).toMatch(/accessibilityLabel=\{zoneChip\.a11y\}/);
    expect(src).toMatch(/\{zonePinned\s*\?\s*<Text style=\{s\.flagText\}>\{chipRegion\.flag\}<\/Text>/);
    expect(src).not.toMatch(/accessibilityLabel=\{`Operating zone: \$\{chipRegion\.name\}`\}/);
    expect(src).not.toMatch(/Change region/);
  });
});

describe('B-868 D3 — ZoneMapScreen is a read-only coverage explorer', () => {
  const zm = code(ZONEMAP);

  it('the route param exists on the param list', () => {
    expect(code(TYPES)).toMatch(/ZoneMap: \{explore\?: boolean\} \| undefined;/);
  });

  it('the quick action is the only door left, and it passes explore', () => {
    const home = code(HOME);
    expect(home).toMatch(/navigateOnce\(navigation, 'ZoneMap', \{explore: true\}\)/);
    // ...and it is the ONLY ZoneMap navigate left on the dashboard (the header
    // chip's door is gone).
    expect((home.match(/'ZoneMap'/g) ?? []).length).toBe(1);
  });

  it('reads `explore` from the route, defaulting to the legacy behaviour', () => {
    expect(zm).toMatch(/const route = useRoute<Rt>\(\);/);
    expect(zm).toMatch(/const explore = route\.params\?\.explore === true;/);
  });

  it('with `explore` it writes NOTHING and simply goes back', () => {
    const cont = zm.slice(zm.indexOf('const handleContinue'), zm.indexOf('const ctaEnabled'));
    expect(cont.length).toBeGreaterThan(150);
    // The guard is the FIRST statement — before the draft write, or the
    // explorer would stamp a hand-picked zone on its way out.
    const guardAt = cont.indexOf('if (explore)');
    const writeAt = cont.indexOf('updateDraft(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(writeAt);
    expect(cont).toMatch(/if \(explore\) \{goBackOnce\(navigation\); return;\}/);
  });

  it('...and the legacy zone-picker write still stands behind the guard', () => {
    const cont = zm.slice(zm.indexOf('const handleContinue'), zm.indexOf('const ctaEnabled'));
    expect(cont).toMatch(/zone_code: selected\.code, zone_label: selected\.name, region: selected\.code,/);
    expect(cont).toMatch(/zone_utc_offset_hours: selected\.utcOffsetHours \?\? null,/);
    expect(cont).toMatch(/navigation\.navigate\('ServiceType'\)/);
  });

  it('the CTA reads "Done" and can never be disabled in explore mode', () => {
    expect(zm).toMatch(/const ctaEnabled = explore \|\| selected\.available;/);
    expect(zm).toMatch(/\{explore \? 'Done' : 'Continue'\}/);
    expect(zm).toMatch(/disabled=\{!ctaEnabled\}/);
  });

  it('D6 — the header states the zone instead of inviting a choice', () => {
    expect(zm).toMatch(/\{explore \? 'LIVE COVERAGE · CPOS ONLINE' : 'STEP 1 · CHOOSE OPERATING ZONE'\}/);
    expect(zm).toMatch(/\{explore \? 'Coverage Map' : 'Select Location'\}/);
  });
});

describe('B-868 D4 — the draft seed derives its zone from LAUNCHED_ZONES', () => {
  const store = code(STORE);

  it('the four fields come from the launched list, not hand-written literals', () => {
    expect(store).toMatch(/import \{LAUNCHED_ZONES\} from '@screens\/booking\/launchedZones';/);
    expect(store).toMatch(/const SEED_ZONE = LAUNCHED_ZONES\[0\];/);
    expect(store).toMatch(/region: SEED_ZONE\.code,/);
    expect(store).toMatch(/zone_code: SEED_ZONE\.code,/);
    expect(store).toMatch(/zone_label: SEED_ZONE\.name,/);
    expect(store).toMatch(/zone_utc_offset_hours: SEED_ZONE\.utcOffsetHours,/);
    // The copies the seed used to carry — a second place to edit on launch day.
    expect(store).not.toMatch(/zone_label: 'UAE — Dubai, Abu Dhabi, Sharjah'/);
    expect(store).not.toMatch(/zone_utc_offset_hours: 4,/);
  });
});

describe('B-868 D5 — the EXECUTIVE service location owns the zone', () => {
  const rev = code(EXECREV);
  const task = code(EXECTASK);

  it('ExecReview derives the zone from the SERVICE pin and writes it in one call', () => {
    const slot = rev.slice(rev.indexOf("if (slot === 'service')"), rev.indexOf("} else if (slot === 'transfer_pickup')"));
    expect(slot.length).toBeGreaterThan(300);
    expect(slot).toMatch(/const code = zoneFromPickup\(/);
    expect(slot).toMatch(/\{lat: p\.pickedLat, lng: p\.pickedLng, country: p\.pickedCountry \?\? null\},\s*zoneParamCodes,/);
    expect(slot).toMatch(/const \{zoneChanged\} = setPickupWithZone\(\{/);
    // An unlaunched pin keeps the pin and leaves the zone alone — the server is
    // the authority and refuses `pickup_outside_region` itself.
    expect(slot).toMatch(/\} else \{\s*updateDraft\(\{pickup\}\);/);
  });

  it('...and the transfer legs of the OLD zone are cleared, never silently', () => {
    const slot = rev.slice(rev.indexOf("if (slot === 'service')"), rev.indexOf("} else if (slot === 'transfer_pickup')"));
    expect(slot).toMatch(/const hadLeg = !!\(before\.transport_pickup \?\? before\.transport_dropoff\);/);
    expect(slot).toMatch(/if \(zoneChanged && hadLeg\) \{/);
    expect(slot).toMatch(/updateDraft\(\{transport_pickup: null, transport_dropoff: null, transport_pickup_time: ''\}\);/);
    expect(slot).toMatch(/setZoneMoveNotice\(zoneChanged && hadLeg \? z\.display : null\);/);
    // The notice is RENDERED, and retires the moment a leg exists again.
    expect(rev).toMatch(/\{zoneMoveNotice && !draft\.transport_pickup && !draft\.transport_dropoff && \(/);
    expect(rev).toMatch(/Transfer legs cleared — the service location moved to \$\{zoneMoveNotice\}\. Add them again\./);
    // P2-5 — it renders WITH the rows it explains (inside the transport
    // section's `enabled` arm), not up in the Service Location card. That is
    // also its dismiss: switching transport off retires the whole arm with it.
    const svcCard = rev.slice(rev.indexOf('SERVICE LOCATION'), rev.indexOf('TASK TYPE'));
    expect(svcCard.length).toBeGreaterThan(200);
    expect(svcCard).not.toContain('zoneMoveNotice');
    const legsFrom = rev.indexOf('TRANSFER TYPE');
    const legs = rev.slice(legsFrom, rev.indexOf('PICKUP LOCATION', legsFrom));
    expect(legs.length).toBeGreaterThan(200);
    expect(legs).toContain('zoneMoveNotice');
  });

  it('the SERVICE picker accepts the launched union; the TRANSFER legs stay walled', () => {
    const svc = rev.slice(rev.indexOf('const openServicePicker'), rev.indexOf('const openTransferPicker'));
    expect(svc.length).toBeGreaterThan(200);
    expect(svc).toMatch(/countryCode: pickupZoneParam,/);
    expect(svc).toMatch(/anyZone: true,/);
    const xfer = rev.slice(rev.indexOf('const openTransferPicker'), rev.indexOf('const [typeOpen'));
    expect(xfer.length).toBeGreaterThan(200);
    expect(xfer).toMatch(/countryCode: draft\.zone_code \|\| 'AE',/);
    expect(xfer).not.toMatch(/anyZone/);
    expect(rev).toMatch(/const zoneParamCodes = useMemo\(\s*\(\) => \[\.\.\.new Set\(\[draft\.zone_code, \.\.\.LAUNCHED_ZONE_CODES\]\.filter\(Boolean\)\)\],/);
  });

  it('ExecTask does the same for its (identical) service-location drain', () => {
    expect(task).toMatch(/const code = zoneFromPickup\(/);
    expect(task).toMatch(/setPickupWithZone\(\{/);
    expect(task).toMatch(/countryCode: pickupZoneParam,/);
    expect(task).toMatch(/anyZone: true,/);
  });

  /**
   * ExecTransportScreen picks the TRANSFER legs only — it never writes
   * `draft.pickup`, so it must NOT move the zone. Pinned as-is so a future
   * sweep does not "finish the job" and let a drop-off re-zone a booking.
   */
  it('ExecTransport leaves the zone alone — it picks no pick-up', () => {
    const tran = code(EXECTRAN);
    expect(tran).not.toMatch(/zoneFromPickup/);
    expect(tran).not.toMatch(/setPickupWithZone/);
    expect(tran).toMatch(/countryCode: draft\.zone_code \|\| 'AE',/);
  });
});
