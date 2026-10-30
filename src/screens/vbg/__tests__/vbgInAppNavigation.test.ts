/**
 * Owner 2026-10-30 — "GeoRisk navigation must stay inside BRAVO App.
 * currently it opens with googlemaps and waze … navigation should start with
 * voice interaction".
 *
 * Pins: (1) no GeoRisk screen hands a location to another app any more,
 * (2) every Navigate opens VBGNavigate, (3) the screen speaks when guidance
 * starts and on every turn, (4) the pure timing rules.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  arrivalAnnouncement, arrivalClock, defaultModeFor, hasArrived, profileFor, remainingSeconds,
  shouldReroute, startAnnouncement, OFF_ROUTE_M, REROUTE_MIN_GAP_MS,
} from '../vbgNavigation';
import type {DirectionsRoute} from '@utils/mapboxDirections';

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const strip = (src: string): string => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

const VBG = (f: string) => strip(read('src/screens/vbg', f));

describe('GeoRisk never hands navigation to another app', () => {
  const files = ['VBGGeoRiskScreen.tsx', 'VBGMapScreen.tsx', 'VBGNearbyScreen.tsx', 'LocationHistoryModal.tsx', 'VBGNavigateScreen.tsx'];
  it.each(files)('%s has no geo:, Apple/Google Maps or Waze hand-off', f => {
    const src = VBG(f);
    expect(src).not.toMatch(/geo:|maps\.apple\.com|maps\.google\.com|google\.com\/maps|comgooglemaps|waze/i);
  });

  it('Navigate on a key point opens the in-app screen', () => {
    expect(VBG('VBGMapScreen.tsx')).toMatch(/navigation\.navigate\('VBGNavigate', navParams\(selected\)\)/);
    expect(VBG('VBGNearbyScreen.tsx')).toMatch(/onTapPoint=\{navigateTo\}/);
    expect(VBG('VBGNearbyScreen.tsx')).toMatch(/onPress=\{\(\) => navigateTo\(kp\)\}/);
    expect(VBG('VBGGeoRiskScreen.tsx')).toMatch(/onTapPoint=\{navigateTo\}/);
    expect(VBG('VBGGeoRiskScreen.tsx')).toMatch(/navigation\.navigate\('VBGNavigate', \{dest: \{lat: kp\.lat, lng: kp\.lng, label: kp\.label\}\}\)/);
    expect(VBG('LocationHistoryModal.tsx')).toMatch(/navigation\.navigate\('VBGNavigate'/);
  });

  it('the route is registered and full screen', () => {
    expect(read('src/navigation/types.ts')).toMatch(/VBGNavigate: \{dest: \{lat: number; lng: number; label: string\}\};/);
    expect(read('src/navigation/BookingNavigator.tsx')).toMatch(/name="VBGNavigate"\s+component=\{VBGNavigateScreen\}/);
    expect(read('src/navigation/MainNavigator.tsx')).toMatch(/VBG_FULLSCREEN_ROUTES = new Set\(\[[^\]]*'VBGNavigate'/);
  });
});

describe('VBGNavigateScreen — Bravo turn-by-turn with voice', () => {
  const src = VBG('VBGNavigateScreen.tsx');

  it('speaks the opening line the moment Start is tapped, then every turn', () => {
    const start = src.slice(src.indexOf('const start = () =>'), src.indexOf('const end = () =>'));
    expect(start).toMatch(/say\(startAnnouncement\(rt, destLabel, modeRef\.current\)\)/);
    expect(start).toMatch(/go\('navigating'\)/);
    expect(src).toMatch(/const cue = pickAnnouncement\(/);
    expect(src).toMatch(/if \(cue && say\(cue\.text\)\) \{/);
    expect(src).toMatch(/say\(arrivalAnnouncement\(destLabel\)\)/);
    expect(src).toMatch(/say\(REROUTE_ANNOUNCEMENT\)/);
  });

  it('voice can be muted, and stops when the screen closes', () => {
    expect(src).toMatch(/setVoiceOn\(v => !v\)/);
    expect(src).toMatch(/useEffect\(\(\) => \(\) => \{ stopGuidance\(\); \}, \[\]\);/);
    expect(strip(read('src/utils/navSpeech.ts'))).toMatch(/if \(getActiveCall\(\) \|\| getActiveGroupCall\(\)\) \{return false;\}/);
  });

  it('routes on the Mapbox map inside the app, from 1 Hz own fixes', () => {
    expect(src).toMatch(/buildAgentTrackerHtml\(MAPBOX_TOKEN\)/);
    expect(src).toMatch(/subscribeOwnPosition\(/);
    expect(src).toMatch(/fetchRouteAlternatives\(/);
    expect(src).not.toMatch(/Linking/);
  });

  it('walking routes do not ask for driving-only speed limits', () => {
    expect(strip(read('src/utils/mapboxDirections.ts'))).toMatch(/\(profile\.startsWith\('driving'\) \? '&annotations=maxspeed' : ''\)/);
  });
});

const route = (over: Partial<DirectionsRoute> = {}): DirectionsRoute => ({
  id: 'r', viaRoad: null, coordinates: [{lng: 55, lat: 25}, {lng: 55.01, lat: 25.01}],
  distanceM: 4200, durationS: 540, maxspeedKph: null,
  steps: [{
    instruction: 'Head north on Al Khail Road', bannerPrimary: 'Al Khail Road', bannerSecondary: null,
    maneuverType: 'depart', modifier: null, distanceM: 4200, location: {lng: 55, lat: 25}, roadName: 'Al Khail Road', voice: [],
  }],
  ...over,
});

describe('vbgNavigation rules', () => {
  it('the opening line names the place, distance, time and first instruction', () => {
    expect(startAnnouncement(route(), 'Al Barsha Police Station', 'drive'))
      .toBe('Starting navigation to Al Barsha Police Station. 4.2 kilometres, about 9 min. Head north on Al Khail Road.');
    expect(startAnnouncement(route({distanceM: 640}), '', 'walk')).toMatch(/^Walking directions to your destination\. 640 metres/);
  });

  it('prefers the Mapbox voice phrasing for the first instruction', () => {
    const r = route();
    r.steps[0].voice = [{distanceAlongGeometryM: 4200, announcement: 'Drive north on Al Khail Road for 4 kilometres.'}];
    expect(startAnnouncement(r, 'X', 'drive')).toMatch(/Drive north on Al Khail Road for 4 kilometres\.$/);
  });

  it('walk is the default for a nearby point, drive otherwise', () => {
    expect(defaultModeFor(800)).toBe('walk');
    expect(defaultModeFor(5000)).toBe('drive');
    expect(profileFor('walk')).toBe('walking');
    expect(profileFor('drive')).toBe('driving-traffic');
  });

  it('re-routes only when clearly off route, on a trustworthy fix, not too often', () => {
    const base = {offRouteM: OFF_ROUTE_M + 40, accuracyM: 10, nowMs: 100_000, lastFetchMs: 0, inFlight: false};
    expect(shouldReroute(base)).toBe(true);
    expect(shouldReroute({...base, offRouteM: OFF_ROUTE_M - 1})).toBe(false);
    expect(shouldReroute({...base, accuracyM: 120})).toBe(false);
    expect(shouldReroute({...base, inFlight: true})).toBe(false);
    expect(shouldReroute({...base, lastFetchMs: base.nowMs - REROUTE_MIN_GAP_MS + 1})).toBe(false);
  });

  it('arrival, remaining time and clock', () => {
    expect(hasArrived(25, 200)).toBe(true);
    expect(hasArrived(400, 20)).toBe(true);
    expect(hasArrived(400, 300)).toBe(false);
    expect(arrivalAnnouncement('Hospital')).toBe('You have arrived at Hospital.');
    expect(remainingSeconds(route(), 2100)).toBe(270);
    const at = new Date(2026, 9, 30, 14, 0, 0).getTime();
    expect(arrivalClock(at, 35 * 60)).toBe('14:35');
  });
});
