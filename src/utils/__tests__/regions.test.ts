import {
  regionFromCountry, isSupportedRegion, regionName, regionFromBBox, detectRegion,
  SUPPORTED_REGION_CODES, REGION_NA, REGIONS, coverageRegionRows,
  zoneFromPickup,
} from '../regions';
import {LAUNCHED_ZONE_CODES} from '../../screens/booking/launchedZones';

describe('region helpers', () => {
  it('maps ISO country → region (case-insensitive)', () => {
    expect(regionFromCountry('AE')).toBe('AE');
    expect(regionFromCountry('ae')).toBe('AE');
    expect(regionFromCountry(' gb ')).toBe('GB');
    expect(regionFromCountry('US')).toBe(REGION_NA);
    expect(regionFromCountry(null)).toBe(REGION_NA);
    expect(regionFromCountry(undefined)).toBe(REGION_NA);
  });

  it('validates supported regions', () => {
    expect(isSupportedRegion('SA')).toBe(true);
    expect(isSupportedRegion('za')).toBe(true);
    expect(isSupportedRegion('XX')).toBe(false);
    expect(isSupportedRegion(null)).toBe(false);
    expect(SUPPORTED_REGION_CODES).toEqual(['AE', 'SA', 'BD', 'GB', 'ZA']);
  });

  it('names regions', () => {
    expect(regionName('BD')).toBe('Bangladesh');
    expect(regionName('GB')).toBe('United Kingdom');
    expect(regionName(null)).toBe('—');
  });
});

describe('regionFromBBox (offline fallback)', () => {
  const cases: Array<[string, number, number, string]> = [
    ['Dubai → AE (not the overlapping SA box)', 25.2048, 55.2708, 'AE'],
    ['Riyadh → SA', 24.7136, 46.6753, 'SA'],
    ['Jeddah → SA', 21.4858, 39.1925, 'SA'],
    ['Dhaka → BD', 23.8103, 90.4125, 'BD'],
    ['London → GB', 51.5074, -0.1278, 'GB'],
    ['Johannesburg → ZA', -26.2041, 28.0473, 'ZA'],
    ['New York → N/A (outside coverage)', 40.7128, -74.006, REGION_NA],
  ];
  it.each(cases)('%s', (_label, lat, lng, expected) => {
    expect(regionFromBBox(lat, lng)).toBe(expected);
  });
});

describe('detectRegion', () => {
  it('prefers the reverse-geocoded country when present', () => {
    // A Dubai fix whose country resolves to SA (e.g. near the border) trusts the geocode.
    expect(detectRegion('SA', 25.2048, 55.2708)).toEqual({region: 'SA', country: 'SA', source: 'geocode'});
    expect(detectRegion('gb', 0, 0)).toEqual({region: 'GB', country: 'GB', source: 'geocode'});
  });

  it('falls back to bounding boxes when the country is unknown', () => {
    expect(detectRegion(null, 25.2048, 55.2708)).toEqual({region: 'AE', country: null, source: 'bbox'});
    expect(detectRegion(undefined, 40.7128, -74.006)).toEqual({region: REGION_NA, country: null, source: 'bbox'});
  });
});

/**
 * Issue 37 (Testing Issues V2, PDF p.42) — "South Africa Is Missing from
 * Provider Coverage Regions", CRITICAL: the pilot launches in South Africa.
 *
 * AgentCoverageScreen hard-coded its own five-country array which drifted from
 * this canonical list — ZA absent, and US present even though it is not a
 * dispatch region at all. Coverage rows are now DERIVED, so the two cannot
 * disagree again.
 */
describe('coverageRegionRows — provider coverage picker (Issue 37)', () => {
  const rows = coverageRegionRows();

  it('offers exactly the supported dispatch regions, in canonical order', () => {
    expect(rows.map(r => r.code)).toEqual([...SUPPORTED_REGION_CODES]);
  });

  it('includes South Africa — the pilot region', () => {
    const za = rows.find(r => r.code === 'ZA');
    expect(za).toBeDefined();
    expect(za?.name).toBe('South Africa');
    // The pilot cities, matching modules/booking/coverageZones.ts.
    expect(za?.cities).toContain('Johannesburg');
    expect(za?.cities).toContain('Cape Town');
  });

  it('implies NO unsupported region (the screen used to list USA)', () => {
    expect(rows.some(r => r.code === 'US')).toBe(false);
    for (const row of rows) {
      expect(isSupportedRegion(row.code)).toBe(true);
    }
  });

  it('every region carries a non-empty city list, so no row renders blank', () => {
    for (const row of rows) {
      expect(row.cities.length).toBeGreaterThan(0);
      expect(row.name.length).toBeGreaterThan(0);
    }
  });

  it('defaults every region OFF — a provider opts in to what it can serve', () => {
    expect(rows.every(r => r.on === false)).toBe(true);
  });

  it('South Africa and Saudi Arabia never share a display badge', () => {
    // ZA badge was 'SA', which is Saudi Arabia's dispatch CODE. Dispatching a
    // detail to the wrong continent is the failure mode this guards.
    const za = REGIONS.find(r => r.code === 'ZA');
    const sa = REGIONS.find(r => r.code === 'SA');
    expect(za?.badge).not.toBe(sa?.badge);
    expect(za?.badge).not.toBe('SA');
  });
});

/**
 * B-861 (plan `docs/planning/SECURE_TRANSFER_ZONE_SCHEDULE_PLAN_2026-09-11.md`
 * §10 A5) — the booking zone is DERIVED from the pick-up pin, so the derivation
 * has to answer two questions the old OPERATING ZONE tiles answered by hand:
 *
 *  1. WHICH region is this point in? The reverse-geocoded ISO-2 country WINS,
 *     because the AE bounding box overlaps Saudi soil in the east Empty Quarter
 *     — the box is the offline fallback, never the authority.
 *  2. Is that region LAUNCHED? `REGION_BBOX` holds BD/GB/SA as well, so a
 *     London or a Riyadh pin is a perfectly good bbox "hit" that the server
 *     then refuses as `unsupported_region`. An unfiltered hit must never be
 *     written into the draft.
 */
describe('B-861 — zoneFromPickup: the zone follows the pick-up pin', () => {
  const LAUNCHED = LAUNCHED_ZONE_CODES;

  it('a UAE pin derives AE', () => {
    expect(zoneFromPickup({lat: 25.2048, lng: 55.2708, country: 'AE'}, LAUNCHED)).toBe('AE');
  });

  it('a South Africa pin derives ZA', () => {
    expect(zoneFromPickup({lat: -26.2041, lng: 28.0473, country: 'ZA'}, LAUNCHED)).toBe('ZA');
  });

  it('a London pin is refused — GB is a REGION, not a launched zone', () => {
    expect(zoneFromPickup({lat: 51.5074, lng: -0.1278, country: 'GB'}, LAUNCHED)).toBeNull();
  });

  it('a Riyadh pin is refused — SA is a REGION, not a launched zone', () => {
    expect(zoneFromPickup({lat: 24.7136, lng: 46.6753, country: 'SA'}, LAUNCHED)).toBeNull();
  });

  it('the GEOCODED country beats the box at the AE/SA border (east Empty Quarter)', () => {
    // (23.0, 52.0) sits inside BOTH the AE box and the SA box. With the country
    // known it is Saudi soil → unlaunched → refused, whatever the box says.
    expect(zoneFromPickup({lat: 23.0, lng: 52.0, country: 'sa'}, LAUNCHED)).toBeNull();
    // With no geocode the box is all we have, and AE is checked first.
    expect(zoneFromPickup({lat: 23.0, lng: 52.0}, LAUNCHED)).toBe('AE');
    expect(zoneFromPickup({lat: 23.0, lng: 52.0, country: null}, LAUNCHED)).toBe('AE');
  });

  it('a point outside every region box is refused', () => {
    // Mid-Atlantic.
    expect(zoneFromPickup({lat: 30.0, lng: -40.0}, LAUNCHED)).toBeNull();
  });

  it('the launched list is the filter — narrowing it narrows the answer', () => {
    expect(zoneFromPickup({lat: -26.2041, lng: 28.0473, country: 'ZA'}, ['AE'])).toBeNull();
    expect(zoneFromPickup({lat: 25.2048, lng: 55.2708, country: 'AE'}, [])).toBeNull();
    // Case/whitespace in the launched list must not open or close the gate.
    expect(zoneFromPickup({lat: 25.2048, lng: 55.2708, country: 'AE'}, [' ae '])).toBe('AE');
  });

  it('LAUNCHED_ZONE_CODES is exactly the two launched zones', () => {
    expect([...LAUNCHED_ZONE_CODES]).toEqual(['AE', 'ZA']);
  });
});

/**
 * B-861 P1-2 — a region ops LAUNCHED AFTER this build.
 *
 * `ZoneMapScreen` appends live regions from `regionsAvailability()` that the
 * compiled seed does not know (its OP-04 path), so a user can legitimately be
 * booking in one. Such a code is absent from `COUNTRY_TO_REGION` and from
 * `REGION_BBOX`, so the compiled derivation answers `N/A` and the pin is
 * refused — the picker would reject the user's own operating zone.
 *
 * `region_code` in this stack IS the ISO-3166 alpha-2 country code, so an
 * explicit geocode naming a code the CALLER has declared launched resolves
 * without a compiled mapping. This does not widen anything else: the code still
 * has to be in `launched`, and the AE/SA border rule is untouched (SA is not in
 * the launched set, so a Saudi pin is still refused).
 */
describe('B-861 P1-2 — a launched code the compiled tables do not know', () => {
  it('an explicit geocode naming a launched code resolves to it', () => {
    expect(zoneFromPickup({lat: -1.2921, lng: 36.8219, country: 'KE'}, ['KE', 'AE', 'ZA'])).toBe('KE');
    expect(zoneFromPickup({lat: -1.2921, lng: 36.8219, country: 'ke'}, ['KE', 'AE', 'ZA'])).toBe('KE');
  });

  it('…and is still refused when the caller has not launched it', () => {
    expect(zoneFromPickup({lat: -1.2921, lng: 36.8219, country: 'KE'}, LAUNCHED_ZONE_CODES)).toBeNull();
  });

  it('the AE/SA border rule is untouched by the new arm', () => {
    // SA is not launched, so the Empty-Quarter pin is still refused …
    expect(zoneFromPickup({lat: 23.0, lng: 52.0, country: 'SA'}, ['AE', 'ZA'])).toBeNull();
    // … and if a caller DID launch SA, the country still beats the AE box.
    expect(zoneFromPickup({lat: 23.0, lng: 52.0, country: 'SA'}, ['AE', 'ZA', 'SA'])).toBe('SA');
  });

  it('with no geocode an unknown launched code has no box, so it refuses', () => {
    // Fail-closed: we will not hand a pin to a zone on a guess.
    expect(zoneFromPickup({lat: -1.2921, lng: 36.8219}, ['KE', 'AE', 'ZA'])).toBeNull();
  });
});
