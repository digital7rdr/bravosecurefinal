/**
 * B-806 — the founder re-sent the check-in screenshot: "see the image it has
 * problem … workspace channel attendance and the person attendance … find out
 * the problem".
 *
 * Three defects sat in that one card, on top of the B-805 crash:
 *
 *   1. The place read "Turag, Dhaka, ঢাকা, Dhaka, Bangladesh" — Mapbox's raw
 *      `place_name`, Dhaka three times (one Bengali) plus the country. BOTH
 *      attendance lists printed the same string.
 *   2. No verification line at all, on an attendance VERIFICATION screen — and
 *      it could never render: all three callers hard-coded the site to null,
 *      while the server's RECORDED verdict (distance_m / within_radius, stored
 *      at clock-in) was already in the payload and ignored.
 *   3. The compass defaults to the top-RIGHT corner, under the style switcher.
 *
 * A critic pass and an edge-case pass then reshaped the fix. The cases below
 * marked REVIEW are theirs, and each one was a real defect in my first cut:
 * the script filter collapsed a whole address to the country name in every
 * non-Latin market; a RECORDED verdict was printed against the LIVE radius; one
 * failed tile blanked a working map; and at z17 the geofence was off-screen for
 * exactly the rows a reviewer opens.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {cleanPlaceName} from '../placeName';

jest.mock('../geo', () => ({
  reverseGeocode: jest.fn(),
  reverseGeocodeStrict: jest.fn(),
  fmtTime: jest.fn(() => ''),
}));

/** The exact string from the founder's screenshot. */
const FOUNDER = 'Turag, Dhaka, ঢাকা, Dhaka, Bangladesh';

describe('cleanPlaceName — the founder\'s screenshot', () => {
  it('turns the screenshot string into something a person would say', () => {
    expect(cleanPlaceName(FOUNDER)).toBe('Turag, Dhaka');
  });

  it('drops a local-script duplicate that sits mid-string', () => {
    expect(cleanPlaceName('Turag, ঢাকা, Bangladesh')).toBe('Turag');
  });

  it('de-dupes NON-adjacent repeats (the old util only did adjacent)', () => {
    expect(cleanPlaceName('Dhaka, Gulshan, DHAKA, Bangladesh')).toBe('Dhaka, Gulshan');
  });

  it('folds the Turkish dotted I, whose toLowerCase never matched its ASCII twin', () => {
    expect(cleanPlaceName('Beşiktaş, İstanbul, Istanbul, Türkiye')).toBe('Beşiktaş, İstanbul');
  });

  it('drops the trailing country generically — no hard-coded country list', () => {
    expect(cleanPlaceName('Sandton City, Johannesburg, South Africa')).toBe('Sandton City, Johannesburg');
    expect(cleanPlaceName('Al Raha, Abu Dhabi, United Arab Emirates')).toBe('Al Raha, Abu Dhabi');
  });

  it('keeps a two-part name whole — dropping the tail there would erase the city', () => {
    expect(cleanPlaceName('Turag, Dhaka')).toBe('Turag, Dhaka');
  });
});

describe('cleanPlaceName — REVIEW: it must not eat the address in a non-Latin market', () => {
  /**
   * My first cut filtered every non-Latin component BEFORE dropping the
   * country, so wherever the country was the only Latin token the filter
   * deleted the whole address and the guard then protected the country:
   * "Аргентинская улица, Москва, Russia" rendered as "Russia". Worse than the
   * noise it was written to remove, and reachable in the founder's own market.
   */
  it.each([
    ['Аргентинская улица, Москва, Russia', 'Аргентинская улица, Москва'],
    ['সাভার, ঢাকা, Bangladesh', 'সাভার, ঢাকা'],
    ['Ερμού 10, Αθήνα, Greece', 'Ερμού 10, Αθήνα'],
    ['渋谷区, 東京都, Japan', '渋谷区, 東京都'],
  ])('%s stays an address, not a country', (input, want) => {
    expect(cleanPlaceName(input)).toBe(want);
  });

  it('keeps a leading local-script STREET when the city is Latin', () => {
    // The server's own stated goal is "Sandton City, Rivonia Rd, Johannesburg",
    // NOT "Johannesburg" — the most specific component is the point.
    expect(cleanPlaceName('شارع الشيخ زايد, Dubai, United Arab Emirates')).toBe('شارع الشيخ زايد, Dubai');
  });

  it('keeps a city whose name equals its country', () => {
    // Dropping the tail by the ORIGINAL count left these as a street alone.
    expect(cleanPlaceName('Rue du Fossé, Luxembourg, Luxembourg')).toBe('Rue du Fossé, Luxembourg');
    expect(cleanPlaceName('Rue de Rome, Djibouti, Djibouti')).toBe('Rue de Rome, Djibouti');
  });

  it('keeps a bare house number — digits are script-neutral', () => {
    // "which building on that street" is the question on a verification screen.
    expect(cleanPlaceName('Rua Augusta, 100, Lisboa, Portugal')).toBe('Rua Augusta, 100, Lisboa');
    expect(cleanPlaceName('12, Jalan Ampang, Kuala Lumpur, Malaysia')).toBe('12, Jalan Ampang, Kuala Lumpur');
  });

  it('never empties a name, and never leaks dangling punctuation', () => {
    // The server truncates at 200 chars and can land on a comma.
    expect(cleanPlaceName('Turag ,')).toBe('Turag');
    expect(cleanPlaceName('ঢাকা, বাংলাদেশ')).toBe('ঢাকা, বাংলাদেশ');
    expect(cleanPlaceName('Turag')).toBe('Turag');
    expect(cleanPlaceName('')).toBe('');
    expect(cleanPlaceName(null)).toBe('');
    expect(cleanPlaceName(undefined)).toBe('');
  });

  it('keeps a full address whole — the row gets two lines, the card three', () => {
    // NOT cropped to two components: "House 12, Road 5" is a number and a
    // street with no city, which is the defect this replaced.
    expect(cleanPlaceName('House 12, Road 5, Dhanmondi, Dhaka 1205, Bangladesh'))
      .toBe('House 12, Road 5, Dhanmondi, Dhaka 1205');
  });
});

/** CRLF-normalised; JS, JSX and SQL comments stripped. */
function code(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    // `--` too: the server columns sit under a five-line SQL comment, so a
    // commented-out column list would otherwise satisfy the Tier 2 scan.
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('--'))
    .join('\n');
}

const SCREEN = code('src/screens/deptchat/CheckInMapScreen.tsx');
const ROWS = code('src/screens/deptchat/attendanceRows.tsx');
const ADMIN = code('src/screens/deptchat/AdminAttendanceScreen.tsx');
const DAY = code('src/screens/deptchat/AttendanceDayScreen.tsx');
const MEMBER = code('src/screens/deptchat/MemberAttendanceScreen.tsx');
const TYPES = code('src/navigation/types.ts');
const API = code('src/services/api.ts');
const SERVICE = code('apps/auth-service/src/attendance/attendance.service.ts');
const GEO = code('src/screens/deptchat/geo.ts');
const SERVER_GEO = code('apps/auth-service/src/vbg/geocode.service.ts');

describe('B-806.1 — every surface shows a CLEANED name', () => {
  it('the card and both lists clean it, and none prints the raw string', () => {
    expect(SCREEN).toMatch(/cleanPlaceName\(name\) \|\| name/);
    for (const src of [ROWS, ADMIN]) {
      expect(src).toMatch(/cleanPlaceName\(resolved\.name\) \|\| resolved\.name/);
      expect(src).not.toMatch(/const place = resolved\.name \?\? /);
    }
  });

  it('REVIEW — both geocoders ask Mapbox for English, so new rows are clean at source', () => {
    // Without this the local-script duplicate is created in the first place,
    // and the server STORES it in clock_in_place where no client cleaner reaches.
    expect((GEO.match(/language=en/g) ?? []).length).toBe(2);
    expect(SERVER_GEO).toMatch(/language=en/);
  });
});

describe('B-806.2 — the verification line renders, off the RECORDED verdict', () => {
  it('the recorded verdict wins; the measured form is the legacy fallback', () => {
    expect(SCREEN).toMatch(/const recorded = typeof params\.withinRadius === 'boolean';/);
    expect(SCREEN).toMatch(/hasSite \? distanceM\(params\.lat, params\.lng, params\.siteLat!, params\.siteLng!\) : null/);
  });

  it('REVIEW — a RECORDED verdict never prints the LIVE radius number', () => {
    // distanceM/withinRadius are frozen at clock-in; params.radiusM is whatever
    // the shift says today, and updateShift lets an admin change it. Joining
    // them produced "200 m from X · outside the 300 m approved radius".
    expect(SCREEN).toMatch(/!recorded && typeof params\.radiusM === 'number' \? ` \(\$\{params\.radiusM\} m\)` : ''/);
  });

  it('REVIEW — a null verdict gets a neutral glyph, never a tick', () => {
    // A tick on a row nothing verified reads as "compliant".
    expect(SCREEN).toMatch(/\{inFence !== null && \(/);
    expect(SCREEN).toMatch(/name=\{inFence \? 'map-marker-check-outline' : 'alert-circle-outline'\}/);
    expect(SCREEN).toMatch(/name=\{inFence === null \? 'map-marker-distance' : 'map-marker-radius-outline'\}/);
  });

  it('REVIEW — a negative recorded distance is refused, and a 0 m one is kept', () => {
    // distanceText returns '' below zero, which would have started the sentence
    // with nothing; 0 is a real measurement and must not be treated as falsy.
    expect(SCREEN).toMatch(/typeof params\.distanceM === 'number' && Number\.isFinite\(params\.distanceM\) && params\.distanceM >= 0/);
  });

  it('REVIEW — a long site label cannot push the verdict off the line', () => {
    expect(SCREEN).toMatch(/rawSite\.length > 28 \? rawSite\.slice\(0, 27\) \+ '…'/);
  });

  it('a shift with NO approved site says so — but never over a recorded verdict', () => {
    expect(SCREEN).toMatch(/const noSite = fromSite === null && !hasSite && !recorded;/);
    expect(SCREEN).toMatch(/No approved site set for this shift/);
  });

  it('a radius of 0 is still a radius (typeof, not truthiness)', () => {
    expect(SCREEN).toMatch(/fromSite !== null && typeof params\.radiusM === 'number' \? fromSite <= params\.radiusM : null/);
  });

  it('all THREE callers forward the site and the verdict — none hard-codes null', () => {
    for (const [name, src] of [['admin', ADMIN], ['day', DAY], ['member', MEMBER]] as const) {
      expect([name, /siteLat: null, siteLng: null, radiusM: null/.test(src)]).toEqual([name, false]);
      expect(src).toMatch(/distanceM: [ps]\.distance_m \?\? null/);
      expect(src).toMatch(/withinRadius: [ps]\.within_radius \?\? null/);
      expect(src).toMatch(/siteLabel: [ps]\.site_label \?\? null/);
      expect(src).toMatch(/siteLat: [ps]\.site_lat \?\? null/);
    }
  });

  it('the route type accepts them', () => {
    const block = TYPES.slice(TYPES.indexOf('CheckInMap: {'));
    expect(block.slice(0, block.indexOf('};'))).toMatch(/distanceM\?: number \| null; withinRadius\?: boolean \| null;/);
  });
});

describe('B-806.3 — the map frames what it is asking about', () => {
  it('REVIEW — with a site, the camera fits BOTH pins instead of zooming to the fix', () => {
    // At z17 the viewport spans ~160-320 m; a default 150 m geofence is 300 m
    // across, so the fence and site pin were off-screen for exactly the
    // out-of-radius rows a reviewer opens.
    expect(SCREEN).toMatch(/\{\.\.\.\(hasSite/);
    expect(SCREEN).toMatch(/\? \{bounds: \{/);
    expect(SCREEN).toMatch(/: \{zoomLevel: FIX_ZOOM, centerCoordinate: \[params\.lng, params\.lat\]\}\)\}/);
  });

  it('REVIEW — recenter restores that same framing, it does not undo it', () => {
    expect(SCREEN).toMatch(/cameraRef\.current\?\.fitBounds\(/);
  });

  it('REVIEW — a failed TILE cannot blank a map that already drew', () => {
    // onMapLoadingError fires per tile and per glyph range, not only per style,
    // and `failed` is sticky — one 404 on a moving connection put an opaque
    // card over a working map.
    expect(SCREEN).toMatch(/onMapLoadingError=\{\(\) => \{ if \(!loadedRef\.current\) \{setFailed\(true\);\} \}\}/);
    expect(SCREEN).toMatch(/loadedRef\.current = true; setLoaded\(true\)/);
  });

  it('REVIEW — RETRY returns to the base style, so one bad style is not a dead end', () => {
    // The failure card covers the switcher, so retrying the same style loops.
    const at = SCREEN.indexOf('const retry = useCallback');
    expect(at).toBeGreaterThan(-1);
    expect(SCREEN.slice(at, SCREEN.indexOf('}, []);', at))).toMatch(/setStyleId\('dark'\)/);
  });

  it('the compass is off the style switcher', () => {
    expect(SCREEN).toMatch(/compassViewPosition=\{0\}/);
    expect(SCREEN).toMatch(/styleBar: \{position: 'absolute', top: 10, right: 10/);
  });
});

describe('B-806 Tier 2 — the server supplies the site the fix was judged against', () => {
  it('the shared session SELECT joins the shift\'s site columns', () => {
    const at = SERVICE.indexOf('DAY_ROW_SELECT');
    expect(at).toBeGreaterThan(-1);
    const sel = SERVICE.slice(at, SERVICE.indexOf('`;', at));
    expect(sel).toMatch(/sh\.site_lat, sh\.site_lng, sh\.approved_radius_m/);
    // The join it reads from was already there — this must not add a second one.
    expect((sel.match(/LEFT JOIN cpo_shifts sh/g) ?? []).length).toBe(1);
  });

  it('all three readers still go through that one select', () => {
    expect((SERVICE.match(/AttendanceService\.dayRowSelect\(folds\)/g) ?? []).length).toBe(3);
  });

  it('both the server row type and the mobile DTO declare the columns', () => {
    expect(SERVICE).toMatch(/site_lat\?: number \| null;/);
    expect(SERVICE).toMatch(/approved_radius_m\?: number \| null;/);
    expect(API).toMatch(/site_lat\?: number \| null;/);
    expect(API).toMatch(/approved_radius_m\?: number \| null;/);
  });

  it('the verdict columns were ALREADY on the wire — this change must not recompute them', () => {
    expect(API).toMatch(/within_radius\?: boolean \| null;/);
    expect(API).toMatch(/distance_m\?: number \| null;/);
  });
});
