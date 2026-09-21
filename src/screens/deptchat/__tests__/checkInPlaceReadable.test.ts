/**
 * B-803 (founder 2026-09-05) — three complaints about one screen:
 *
 *   "who can understand this coordinate? please make it human readable"
 *   "also it's blank not opening map"
 *   "also this map more details with mapbox sdk inherited as much as can … I mean rich"
 *
 * The card printed `placeLabel()`'s coordinate FALLBACK where a place name
 * belongs, and then printed the same coordinate again on the line below — so
 * the screenshot showed `23.83167, 90.38008` twice and no address anywhere.
 *
 * The resolver below is the fix's core; the screen itself is a SOURCE SCAN
 * because it mounts RN + `@rnmapbox/maps`, whose native module cannot load in
 * the test environment. Comments are stripped before every assertion (this
 * screen's docblock quotes the very tokens under test) and the file is CRLF, so
 * nothing is `\n`-anchored.
 *
 * Critic pass on the first cut (2026-09-05) changed three things pinned here:
 * the geocoder the resolver calls must be able to THROW (else offline is cached
 * as a permanent miss), the extrusion layer must sit UNDER the label layer
 * (else roofs hide every label at street zoom — the real "no labels"), and the
 * mission map keeps traffic on Standard ('3d').
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  __resetPlaceCacheForTests,
  coordHuman,
  coordText,
  distanceM,
  distanceText,
  isCoordText,
  resolvePlaceName,
  validFix,
} from '../placeName';
import {reverseGeocodeStrict} from '../geo';

jest.mock('../geo', () => ({
  reverseGeocode: jest.fn(),
  reverseGeocodeStrict: jest.fn(),
  fmtTime: jest.fn(() => ''),
}));

const mockReverse = reverseGeocodeStrict as jest.MockedFunction<typeof reverseGeocodeStrict>;

beforeEach(() => {
  __resetPlaceCacheForTests();
  mockReverse.mockReset();
});

describe('a coordinate is not a place name', () => {
  it('recognises the exact string the old card displayed', () => {
    // The founder's screenshot, verbatim.
    expect(isCoordText('23.83167, 90.38008')).toBe(true);
    expect(isCoordText('-26.10761,28.05623')).toBe(true);
    expect(isCoordText(' 23.83167 ,  90.38008 ')).toBe(true);
  });

  it('does not mistake a real address for one', () => {
    expect(isCoordText('Sandton City, Johannesburg')).toBe(false);
    expect(isCoordText('House 12, Road 5')).toBe(false);
    // A name that merely CONTAINS numbers is still a name.
    expect(isCoordText('Sector 10, Uttara')).toBe(false);
    expect(isCoordText('')).toBe(false);
    expect(isCoordText(null)).toBe(false);
  });

  it('coordText still reproduces what placeLabel emits, so the two agree', () => {
    expect(coordText(23.831672, 90.380081)).toBe('23.83167, 90.38008');
    expect(isCoordText(coordText(23.831672, 90.380081))).toBe(true);
  });

  it('coordHuman labels the hemisphere so a sign is not the only difference', () => {
    expect(coordHuman(23.83167, 90.38008)).toBe('23.83167° N, 90.38008° E');
    expect(coordHuman(-26.10761, -28.05623)).toBe('26.10761° S, 28.05623° W');
  });
});

describe('validFix — the same rules hasFix already applies', () => {
  it('refuses null island, non-finite and out-of-range', () => {
    expect(validFix(23.83, 90.38)).toBe(true);
    expect(validFix(0, 0)).toBe(false);
    expect(validFix(null, 90)).toBe(false);
    expect(validFix(NaN, 90)).toBe(false);
    expect(validFix(91, 90)).toBe(false);
    expect(validFix(23, 181)).toBe(false);
  });
});

describe('resolvePlaceName — one request per site, not per row', () => {
  it('resolves a name from the fix', async () => {
    mockReverse.mockResolvedValue('Dhanmondi, Dhaka');
    await expect(resolvePlaceName(23.83167, 90.38008)).resolves.toBe('Dhanmondi, Dhaka');
    expect(mockReverse).toHaveBeenCalledTimes(1);
  });

  it('caches, so twenty rows at one site cost ONE request', async () => {
    mockReverse.mockResolvedValue('Dhanmondi, Dhaka');
    await resolvePlaceName(23.83167, 90.38008);
    for (let i = 0; i < 19; i++) {
      await resolvePlaceName(23.83167, 90.38008);
    }
    expect(mockReverse).toHaveBeenCalledTimes(1);
  });

  it('dedupes IN FLIGHT — a list mounting twenty rows in one frame fires once', async () => {
    let release: (v: string) => void = () => {};
    mockReverse.mockReturnValue(new Promise<string>(res => {release = res;}));
    const all = Promise.all(Array.from({length: 20}, () => resolvePlaceName(23.83167, 90.38008)));
    release('Dhanmondi, Dhaka');
    const names = await all;
    expect(mockReverse).toHaveBeenCalledTimes(1);
    expect(new Set(names)).toEqual(new Set(['Dhanmondi, Dhaka']));
  });

  it('two fixes in the same ~11 m cell share an answer; neighbouring sites do not', async () => {
    mockReverse.mockResolvedValue('Site A');
    await resolvePlaceName(23.83167, 90.38008);
    await resolvePlaceName(23.831671, 90.380083); // same cell — cached
    expect(mockReverse).toHaveBeenCalledTimes(1);
    mockReverse.mockResolvedValue('Site B');
    // ~100 m away: a different cell, so it must NOT inherit Site A's name.
    await expect(resolvePlaceName(23.8327, 90.3811)).resolves.toBe('Site B');
    expect(mockReverse).toHaveBeenCalledTimes(2);
  });

  it('a MISS is cached (Mapbox has no name here — asking again will not change that)', async () => {
    mockReverse.mockResolvedValue(null);
    await expect(resolvePlaceName(23.83167, 90.38008)).resolves.toBeNull();
    await resolvePlaceName(23.83167, 90.38008);
    expect(mockReverse).toHaveBeenCalledTimes(1);
  });

  it('a THROWN error is NOT cached — back on signal, the next mount may retry', async () => {
    // The STRICT geocoder really throws for offline / 429 / no token — the
    // lenient one folds all of those into null, which is why the resolver must
    // not use it (a cached null there was a permanent "unavailable").
    mockReverse.mockRejectedValueOnce(new Error('mapbox geocoding 429'));
    await expect(resolvePlaceName(23.83167, 90.38008)).resolves.toBeNull();
    mockReverse.mockResolvedValue('Dhanmondi, Dhaka');
    await expect(resolvePlaceName(23.83167, 90.38008)).resolves.toBe('Dhanmondi, Dhaka');
    expect(mockReverse).toHaveBeenCalledTimes(2);
  });

  it('a geocoder that echoes the coordinate has NOT named anything', async () => {
    // Otherwise the fix reintroduces itself: a "name" that is the same numbers.
    mockReverse.mockResolvedValue('23.83167, 90.38008');
    await expect(resolvePlaceName(23.83167, 90.38008)).resolves.toBeNull();
  });

  it('never calls out for an unusable fix', async () => {
    await expect(resolvePlaceName(0, 0)).resolves.toBeNull();
    await expect(resolvePlaceName(NaN, 5)).resolves.toBeNull();
    expect(mockReverse).not.toHaveBeenCalled();
  });
});

describe('distance from the approved site — the manager\'s actual question', () => {
  it('is metres at site scale', () => {
    // ~111 m of latitude.
    expect(distanceM(23.83167, 90.38008, 23.83267, 90.38008)).toBeGreaterThan(105);
    expect(distanceM(23.83167, 90.38008, 23.83267, 90.38008)).toBeLessThan(118);
    expect(distanceM(23.83167, 90.38008, 23.83167, 90.38008)).toBe(0);
  });

  it('reads as a distance, not as a float', () => {
    expect(distanceText(0)).toBe('0 m');
    expect(distanceText(180)).toBe('180 m');
    expect(distanceText(1400)).toBe('1.4 km');
    expect(distanceText(24_000)).toBe('24 km');
  });
});

/** CRLF-normalised, comments stripped. */
function code(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
}

describe('the strict geocoder really is strict (the resolver\'s contract)', () => {
  const GEO = code('src/screens/deptchat/geo.ts');

  it('throws on a non-OK response and on a missing token; null only for zero features', () => {
    const start = GEO.indexOf('export async function reverseGeocodeStrict');
    expect(start).toBeGreaterThan(-1);
    const body = GEO.slice(start, GEO.indexOf('\n}', start));
    expect(body).toMatch(/if \(!res\.ok\) \{throw new Error/);
    expect(body).toMatch(/if \(!token\) \{throw new Error/);
    expect(body).not.toMatch(/catch/);
  });

  it('and the resolver calls THAT one, not the lenient sibling', () => {
    const PLACE = code('src/screens/deptchat/placeName.ts');
    expect(PLACE).toMatch(/reverseGeocodeStrict\(lat, lng\)/);
    expect(PLACE).not.toMatch(/\breverseGeocode\(/);
  });
});

describe('the check-in screen answers all three complaints', () => {
  const SCREEN = code('src/screens/deptchat/CheckInMapScreen.tsx');

  it('the scan is reading the real screen (guards a vacuous pass)', () => {
    expect(SCREEN.length).toBeGreaterThan(3_000);
    expect(SCREEN).toContain('Mapbox.MapView');
  });

  it('shows a resolved NAME, never the coordinate in the name slot', () => {
    expect(SCREEN).toMatch(/useResolvedPlace\(params\.place, params\.lat, params\.lng\)/);
    // The old shape: params.place printed raw, coordinate or not.
    expect(SCREEN).not.toMatch(/params\.place\?\.trim\(\) \|\|/);
  });

  it('prints the coordinate ONCE, labelled as the GPS fix, with no line cap', () => {
    expect(SCREEN).toMatch(/<Text style=\{s\.coords\}>GPS fix · \{coordHuman\(params\.lat, params\.lng\)\}<\/Text>/);
    // The duplicate line that made the founder's screenshot say it twice.
    expect(SCREEN).not.toMatch(/params\.lat\.toFixed\(5\)/);
  });

  it('has a load state AND a failure state — offline is a RETRY card, not an eternal "Loading…"', () => {
    // B-806 also sets a ref here, so a failed TILE cannot blank a drawn map.
    expect(SCREEN).toMatch(/onDidFinishLoadingMap=\{\(\) => \{ loadedRef\.current = true; setLoaded\(true\); \}\}/);
    // B-806 narrowed this to a PRE-load failure: the event also fires per failed
    // tile and per glyph range, and `failed` is sticky, so one 404 on a moving
    // connection covered a working map with the failure card.
    expect(SCREEN).toMatch(/onMapLoadingError=\{\(\) => \{ if \(!loadedRef\.current\) \{setFailed\(true\);\} \}\}/);
    expect(SCREEN).toMatch(/<MapFailedOverlay variant="connection" onRetry=\{retry\} \/>/);
    expect(SCREEN).toMatch(/!loaded && <MapFailedOverlay variant="loading"/);
    // RETRY remounts the map, or it retries nothing.
    expect(SCREEN).toMatch(/key=\{attempt\}/);
    expect(SCREEN).toMatch(/setAttempt\(n => n \+ 1\)/);
  });

  it('inherits the shared SDK detail at FULL rich parity ("I mean rich") rather than hand-rolling a third map', () => {
    // No `traffic={false}` and no `detail` gate: the check-in map draws
    // everything the mission map draws, from the one shared component.
    expect(SCREEN).toMatch(/<RichDetailLayers styleId=\{styleId\} \/>/);
    expect(SCREEN).not.toMatch(/traffic=\{false\}/);
    expect(SCREEN).toMatch(/from '@\/modules\/maps\/mapDetail'/);
    // The same four styles the mission map uses — no private URL list here.
    expect(SCREEN).toMatch(/import \{STYLE_URL\} from '@\/modules\/maps\/BravoMap'/);
    expect(SCREEN).not.toMatch(/mapbox:\/\/styles\//);
    // A pitched camera, or the 3D buildings are invisible from straight above.
    expect(SCREEN).toMatch(/pitch=\{FIX_PITCH\}/);
  });

  it('B-805 — no localizeLabels: a no-op on our styles and an UNGUARDED native call', () => {
    // dark-v11 / light-v11 already resolve coalesce(name_en, name), so it bought
    // nothing. RNMBXMapView.applyLocalizeLabels runs it on EVERY style load with
    // no try/catch, walking the loaded style's layers — and Standard is a
    // style-IMPORT style. Prime suspect for the crash; removed at zero cost.
    expect(SCREEN).not.toMatch(/localizeLabels/);
  });

  it('keeps Mapbox attribution reachable (their terms), like the mission map', () => {
    expect(SCREEN).toMatch(/attributionEnabled/);
    expect(SCREEN).not.toMatch(/attributionEnabled=\{false\}/);
  });

  it('offers satellite — what actually identifies a gate or a yard', () => {
    expect(SCREEN).toMatch(/STYLES: BravoMapStyleId\[\] = \['dark', 'sat', 'light'\]/);
    // B-805 — Mapbox Standard is OFF the switcher: it hard-crashed on device
    // the moment the founder tapped it (1.0.297). Scoped to the ARRAY, because
    // '3d' legitimately survives as a key of the STYLE_ICON record (the Record
    // type demands every style id) — a whole-file negative would fail on that.
    const styles = SCREEN.slice(SCREEN.indexOf('const STYLES: BravoMapStyleId[]'));
    expect(styles.slice(0, styles.indexOf('];'))).not.toMatch(/'3d'/);
    expect(SCREEN).toMatch(/MAP_STYLE_LABEL\[id\]/);
  });

  it('touch targets meet the 48 dp bar: 40 dp buttons + 4 dp slop, 8 dp gap so slops do not overlap', () => {
    expect(SCREEN).toMatch(/styleBtn: \{width: 40, height: 40/);
    expect(SCREEN).toMatch(/styleBar: \{[^}]*gap: 8/);
    expect(SCREEN).toMatch(/recenter: \{[^}]*width: 44, height: 44/);
  });
});

describe('the shared detail layers stay shared — and correct', () => {
  const DETAIL = code('src/modules/maps/mapDetail.tsx');
  const NATIVE = code('src/modules/maps/BravoMap.tsx');

  it('BravoMap renders the SHARED component, not its own copy of the layers', () => {
    expect(NATIVE).toMatch(/<RichDetailLayers styleId=\{styleId\} belowLayerID="bravo-route-ahead-line" \/>/);
    // The inline copies are gone — two traffic ramps is exactly the drift the
    // nativeMapParity suite exists to prevent.
    expect(NATIVE).not.toContain('mapbox://mapbox.mapbox-traffic-v1');
    expect(NATIVE).not.toContain('bravo-buildings-3d');
  });

  it('the layer ids and the traffic ramp survived the move unchanged', () => {
    expect(DETAIL).toContain('mapbox://mapbox.mapbox-traffic-v1');
    expect(DETAIL).toContain('bravo-buildings-3d');
    expect(DETAIL).toContain('bravo-sky');
    for (const c of ['#3DD68C', '#E8B33D', '#F2704B', '#C62828']) {
      expect(DETAIL).toContain(c);
    }
  });

  it('extrusions sit UNDER the first label layer — roofs above labels was the real "no labels"', () => {
    expect(DETAIL).toMatch(/FIRST_LABEL_LAYER = 'road-label-simple'/);
    const ext = DETAIL.slice(DETAIL.indexOf('<Mapbox.FillExtrusionLayer'));
    expect(ext.slice(0, ext.indexOf('/>'))).toMatch(/belowLayerID=\{FIRST_LABEL_LAYER\}/);
  });

  it('B-805 — NO custom layer reaches Mapbox Standard: both guards refuse it', () => {
    // Reversed from the critic round: restoring traffic on Standard matched HEAD,
    // but HEAD had never run on a device and Standard then crashed on one.
    // RNMBXLayer.addBelow/addAbove call the native add OUTSIDE the Logger.logged
    // wrapper, so a throw there is a crash, not a log line.
    expect(DETAIL).toMatch(/function supportsTraffic\([^)]*\): boolean \{\s*return styleId !== 'sat' && styleId !== '3d';/);
    expect(DETAIL).toMatch(/function supportsDetailLayers\([^)]*\): boolean \{\s*return styleId !== 'sat' && styleId !== '3d';/);
  });
});

describe('the attendance lists read as places too', () => {
  it('SessionRow resolves the WHERE line and shows the cleaned name', () => {
    const ROWS = code('src/screens/deptchat/attendanceRows.tsx');
    expect(ROWS).toMatch(/useResolvedPlace\(s\.clock_in_place, s\.clock_in_lat, s\.clock_in_lng\)/);
    // B-806 re-pointed this: the row printed the RAW resolved name, which for
    // the founder's own check-in was "Turag, Dhaka, ঢাকা, Dhaka, Bangladesh".
    expect(ROWS).toMatch(/const place = resolved\.name \? \(cleanPlaceName\(resolved\.name\) \|\| resolved\.name\) : placeLabel\(s\)/);
    // Still never @utils/placeLabel's shortPlaceLabel, which keeps only the
    // FIRST component and turns "Road 5, Dhanmondi, Dhaka" into "Road 5".
    expect(ROWS).not.toMatch(/shortPlaceLabel/);
  });

  it('the admin pending-review rows go through the same resolver (they were the half left raw)', () => {
    const ADMIN = code('src/screens/deptchat/AdminAttendanceScreen.tsx');
    expect(ADMIN).toMatch(/function PendingWhere\(/);
    expect(ADMIN).toMatch(/useResolvedPlace\(p\.clock_in_place, p\.clock_in_lat, p\.clock_in_lng\)/);
    expect(ADMIN).toMatch(/<PendingWhere p=\{p\} onOpen=\{openMap\} \/>/);
    // No bare coordinate fallback left in the row's own Text.
    expect(ADMIN).not.toMatch(/numberOfLines=\{2\}>\{placeLabel\(p\)\}/);
  });
});
