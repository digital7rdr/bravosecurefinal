/**
 * B-788 — the map's distance restriction is gone; the zone's country box is
 * the only gate, and the city rings are hints.
 *
 * Founder, 2026-09-03: _"Remove the distance restrictions from Secure Transfers
 * and Executive Protection on the map. I was in Cape Town and wanted to book
 * Western Cape; it showed 'out of coverage 99 km' but the client wants no
 * restriction."_ And, on dispatch: _"The service provider decides whether the
 * distance is operationally feasible."_
 *
 * The restriction lived ONLY on the phone: `COVERAGE_ZONES` city circles gated
 * CONFIRM via `checkCoverage().inCoverage`, while the server prices and accepts
 * anything inside the region's country box. The first suite pins the new rule
 * on the pure helpers; the second pins the SCREEN (an RN component the node
 * project cannot import) by reading its source — CRLF normalised, comments
 * stripped, so prose can neither satisfy nor break an assertion about CODE.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isInsideRegionBox, regionFromBBox} from '../../../utils/regions';
import {checkCoverage} from '../../../modules/booking/coverageZones';

// Real places. Langebaan is ~100 km north of Cape Town; Worcester ~110 km east.
const LANGEBAAN = {lat: -33.09, lng: 18.03};
const WORCESTER = {lat: -33.65, lng: 19.45};
const HARARE = {lat: -17.83, lng: 31.05};     // outside South Africa's box
const DUBAI = {lat: 25.2048, lng: 55.2708};

describe('the gate is the zone box, not a hub ring', () => {
  it('a Western Cape pickup 100 km from Cape Town is bookable in ZA', () => {
    expect(isInsideRegionBox('ZA', LANGEBAAN.lat, LANGEBAAN.lng)).toBe(true);
    expect(isInsideRegionBox('ZA', WORCESTER.lat, WORCESTER.lng)).toBe(true);
  });

  it('the hub check still says how far the nearest hub is — as information', () => {
    const hub = checkCoverage(LANGEBAAN.lat, LANGEBAAN.lng, 'ZA');
    expect(hub.nearHub).toBe(false);
    expect(hub.nearest?.label).toBe('Cape Town');
    expect(hub.distanceKm).toBeGreaterThan(80);
    expect(hub.distanceKm).toBeLessThan(130);
  });

  it('a pin outside the zone box is refused by the box, whatever the rings say', () => {
    expect(isInsideRegionBox('ZA', HARARE.lat, HARARE.lng)).toBe(false);
    expect(isInsideRegionBox('ZA', DUBAI.lat, DUBAI.lng)).toBe(false);
  });

  it('a region with no box is UNKNOWN (null), never refused on the phone', () => {
    // The server is the authority for such a region; it refuses itself.
    expect(isInsideRegionBox('XX', LANGEBAAN.lat, LANGEBAAN.lng)).toBeNull();
    expect(isInsideRegionBox(null, 1, 1)).toBeNull();
  });

  it('is case-insensitive about the zone code and safe on bad coordinates', () => {
    expect(isInsideRegionBox('za', LANGEBAAN.lat, LANGEBAAN.lng)).toBe(true);
    expect(isInsideRegionBox('ZA', Number.NaN, 18)).toBe(false);
    expect(isInsideRegionBox('ZA', null, null)).toBe(false);
  });

  it('agrees with the offline region detector the zone chip relies on', () => {
    expect(regionFromBBox(LANGEBAAN.lat, LANGEBAAN.lng)).toBe('ZA');
    expect(regionFromBBox(DUBAI.lat, DUBAI.lng)).toBe('AE');
  });

  it('the ring result no longer carries a gate-shaped name', () => {
    // `inCoverage` was the field every gate read. Renaming it is what makes a
    // re-introduced ring gate fail to compile rather than ship.
    const hub = checkCoverage(DUBAI.lat, DUBAI.lng, 'AE') as unknown as Record<string, unknown>;
    expect(hub).not.toHaveProperty('inCoverage');
    expect(hub).toHaveProperty('nearHub', true);
  });
});

// ─── the screen ─────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const f = (...p: string[]) => join(ROOT, 'src', ...p);
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n');
}
const PICKER = code(f('screens', 'booking', 'LocationPickerScreen.tsx'));
const HTML = code(f('modules', 'booking', 'bravoLocationPickerMapHtml.ts'));

describe('LocationPickerScreen — the zone is the authority', () => {
  /**
   * B-861 (SECURE_TRANSFER_ZONE_SCHEDULE_PLAN_2026-09-11 A5/A12) — `countryCode`
   * may now carry the LAUNCHED LIST ('AE,ZA') for a Lite pick-up, because the
   * zone FOLLOWS the pin. These pins are re-pointed, never relaxed: the box is
   * still the only wall, the ring is still only a hint, and the single-zone
   * shape (the drop-off, every Executive picker) is unchanged — that one is the
   * only cross-zone check, since the server does not check the drop-off at all.
   */
  it('CONFIRM is gated on the zone box and nothing else', () => {
    // Anchored to the END of the statement: a mutant that AND-ed the hub ring
    // back in (`!== false && hub.nearHub`) still prefix-matched the old scan.
    expect(PICKER).toMatch(
      /const insideZone = anyZone\s*\?\s*pinZone !== null\s*:\s*isInsideRegionBox\(primaryCode, pin\.lat, pin\.lng\) !== false;/);
    // The multi-zone arm is the SAME box rule plus the launched filter, never a
    // ring and never an unconditional allow.
    expect(PICKER).toMatch(/zoneFromPickup\(\s*\{lat: pin\.lat, lng: pin\.lng, country: pin\.country\}, zoneCodes\)/);
    // The ring result may inform the banner and NOTHING else.
    expect((PICKER.match(/nearHub/g) ?? []).length).toBe(1);
    expect(PICKER).not.toMatch(/insideZone[^\n]*nearHub|nearHub[^\n]*insideZone/);
    // B-861 follow-up — a THIRD term joined both gates: a searched pin has no
    // country until the recentre's moveend geocodes it, and the bbox arm alone
    // cannot separate AE from SA in the Empty Quarter. It is a READINESS term,
    // never a relaxation, so `!insideZone` still leads both and the definition
    // of `insideZone` above is unchanged.
    expect(PICKER).toMatch(
      /disabled=\{!insideZone \|\| mapState !== 'ready' \|\| awaitingGeocode\}/);
    expect(PICKER).toMatch(/if \(!insideZone \|\| awaitingGeocode\) \{return;\}/);
    // …and it is armed ONLY by the search path, never by a dragged pin.
    expect(PICKER).toMatch(/setAwaitingGeocode\(true\);/);
    expect((PICKER.match(/setAwaitingGeocode\(true\)/g) ?? []).length).toBe(1);
    // The ring gate, by every name it had.
    expect(PICKER).not.toMatch(/inCoverage/);
    expect(PICKER).not.toMatch(/OUT OF COVERAGE/);
    expect(PICKER).not.toMatch(/hasZones/);
    expect(PICKER).not.toMatch(/NOT AVAILABLE IN THIS REGION/);
  });

  it('shows hub distance as information, never as a refusal', () => {
    expect(PICKER).toMatch(/nearest Bravo hub \$\{hub\.nearest\.label\}, \$\{hub\.distanceKm\} km/);
    // B-861 — one-zone callers keep the "change the booking zone" door in the
    // copy; the launched-list caller has no zone left to change, so it names
    // where we DO operate instead.
    expect(PICKER).toMatch(/Outside \$\{zone\?\.name \?\? primaryCode\} — move the pin or change the booking zone/);
    expect(PICKER).toMatch(/We don't operate here yet — pick a location in \$\{launchedZonesLabel\(\)\}/);
  });

  it('honours a remembered pin anywhere inside the zone box (B-788)', () => {
    expect(PICKER).toMatch(
      /zoneCodes\.some\(\s*c => isInsideRegionBox\(c, initial\.latitude, initial\.longitude\) !== false\)/);
    expect(PICKER).not.toMatch(/distanceKm\(initial/);
  });

  it('does NOT yank the map to GPS when the phone is in another zone (B-789)', () => {
    const effect = PICKER.slice(PICKER.indexOf('const autoCentredRef'));
    const call = effect.slice(0, effect.indexOf('const locateMe'));
    expect(call).toMatch(/const dev = regionFromBBox\(pos\.coords\.latitude, pos\.coords\.longitude\)/);
    // B-861 — "the zone being booked" became "any zone this picker accepts".
    expect(call).toMatch(/if \(zoneCodes\.includes\(dev\)\) \{\s*pushMeToMap/);
    // The crosshair (manual) still centres unconditionally.
    const manual = PICKER.slice(PICKER.indexOf('const fetchPosition'), PICKER.indexOf('const fetchPosition') + 400);
    expect(manual).toMatch(/pushMeToMap\(pos\.coords\.latitude, pos\.coords\.longitude\)/);
  });

  it('B-861 — the pin carries its geocoded country, and the country WINS', () => {
    // A5: the AE box overlaps Saudi soil, so the box alone would hand a Saudi
    // pin the UAE zone. `msg.country` used to be parsed and thrown away.
    // P2-10 — `||`, never `??`: a blank `short_code` is a truthy-looking
    // "geocode" that cannot resolve and cannot fall back to the box either.
    expect(PICKER).toMatch(/country: msg\.country \|\| null,/);
    expect(PICKER).toMatch(/pickedCountry: pin\.country \|\| undefined,/);
  });

  it('scopes the address search to the ZONE country, never to the pin (B-789a)', () => {
    expect(PICKER).toMatch(/const country = countryCode\.toLowerCase\(\);/);
    expect(PICKER).not.toMatch(/pinCountry/);
    expect(PICKER).not.toMatch(/setPinCountry/);
    // ...and ranks around the pin only while it is inside the zone.
    expect(PICKER).toMatch(/insideZone \? \{lat: pin\.lat, lng: pin\.lng\} : initialCenter/);
  });

  it('retries world-wide once when the zone returns nothing', () => {
    expect(PICKER).toMatch(/let suggestions = await suggest\(true\);/);
    expect(PICKER).toMatch(/if \(suggestions\.length === 0\) \{suggestions = await suggest\(false\);\}/);
  });

  /**
   * B-861 A7 — the "· Change" door to ZoneMap is REMOVED and this pin is
   * FLIPPED. B-789c put a zone door where the user was; the zone now follows
   * the pin they are placing, so a second zone control on the same screen could
   * only contradict it. The chip stays, informational: it names the derived
   * zone once a pin resolves, and names where we operate before that.
   */
  it('B-861 — the zone chip is informational; the ZoneMap door is gone', () => {
    expect(PICKER).not.toMatch(/navigateOnce\(navigation, 'ZoneMap'\)/);
    expect(PICKER).not.toMatch(/· Change/);
    expect(PICKER).toMatch(/Zone follows your pick-up · \$\{launchedZonesLabel\(\)\}/);
    // The chip is no longer a button at all — anchored on the element that
    // OPENS it, so a 500-char window cannot accidentally swallow the search
    // bar's own onPress and pass (or fail) for the wrong reason.
    const at = PICKER.indexOf('zs.chip,');
    expect(at).toBeGreaterThan(-1);
    const chipOpen = PICKER.slice(PICKER.lastIndexOf('<', at), at);
    expect(chipOpen).toMatch(/^<View /);
    expect(chipOpen).not.toMatch(/TouchableOpacity|Pressable/);
  });

  it('draws the rings as hubs, not as coverage', () => {
    expect(HTML).toMatch(/Bravo hubs/);
    expect(HTML).not.toMatch(/<\/span>Coverage</);
  });
});
