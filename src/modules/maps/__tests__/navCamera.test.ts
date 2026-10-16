import {ARRIVAL_M, NAV_PITCH, ZOOM_STEP, navCameraFor, progressShareText, shouldRetarget} from '../navCamera';

/**
 * Navigation Ver 2 (2026-10-16) — founder: "the navigation does not get
 * zoomed in as we approach the location." These pin the one rule both maps
 * now share: wide at speed, closer at a turn, closest on arrival.
 */
const open = (speedKph: number | null, mode: 'course' | 'north' = 'course') =>
  navCameraFor({speedKph, distToManeuverM: 5000, distToDestinationM: 20000, mode});

describe('navCameraFor — speed opens the view, closeness closes it', () => {
  it('motorway speed is wider than city speed', () => {
    expect(open(120).zoom).toBeLessThan(open(60).zoom);
    expect(open(60).zoom).toBeLessThan(open(15).zoom);
    expect(open(null).zoom).toBe(16.5);
  });

  it('zooms IN as a turn approaches, even at speed', () => {
    const far = navCameraFor({speedKph: 100, distToManeuverM: 2000, distToDestinationM: 9000, mode: 'course'});
    const near = navCameraFor({speedKph: 100, distToManeuverM: 250, distToDestinationM: 9000, mode: 'course'});
    const at = navCameraFor({speedKph: 100, distToManeuverM: 80, distToDestinationM: 9000, mode: 'course'});
    expect(far.zoom).toBe(16);
    expect(near.zoom).toBeGreaterThan(far.zoom);
    expect(at.zoom).toBeGreaterThan(near.zoom);
    expect(at.zoom).toBe(18);
  });

  it('zooms IN as the destination approaches and flattens on arrival', () => {
    const z = (d: number) => navCameraFor({speedKph: 40, distToManeuverM: d, distToDestinationM: d, mode: 'course'});
    expect(z(900).zoom).toBe(17);
    expect(z(400).zoom).toBe(17.5);
    expect(z(150).zoom).toBe(18);
    expect(z(ARRIVAL_M).zoom).toBe(18.5);
    expect(z(900).pitch).toBe(NAV_PITCH);
    expect(z(ARRIVAL_M).pitch).toBeLessThan(NAV_PITCH);
  });

  it('north-up is half a level wider and flat', () => {
    expect(open(60, 'north').zoom).toBe(open(60, 'course').zoom - 0.5);
    expect(open(60, 'north').pitch).toBe(0);
  });

  it('never leaves the 14–18.5 band', () => {
    expect(navCameraFor({speedKph: 300, distToManeuverM: null, distToDestinationM: null, mode: 'north'}).zoom).toBeGreaterThanOrEqual(14);
    expect(navCameraFor({speedKph: 0, distToManeuverM: 0, distToDestinationM: 0, mode: 'course'}).zoom).toBe(18.5);
  });
});

describe('shouldRetarget — the camera does not breathe on GPS wobble', () => {
  it('first frame always sends; small changes do not; a real step or a pitch change does', () => {
    const a = {zoom: 16.5, pitch: 55};
    expect(shouldRetarget(null, a)).toBe(true);
    expect(shouldRetarget(a, {zoom: 16.5 + ZOOM_STEP / 2, pitch: 55})).toBe(false);
    expect(shouldRetarget(a, {zoom: 16.5 + ZOOM_STEP, pitch: 55})).toBe(true);
    expect(shouldRetarget(a, {zoom: 16.5, pitch: 30})).toBe(true);
  });
});

describe('progressShareText', () => {
  it('reads as one line the control room can act on', () => {
    expect(progressShareText({etaText: '13:24', remainingLabel: '12 km', roadName: 'E11', shortCode: 'MSN-4F2A', targetLabel: 'pickup'}))
      .toBe('Progress update (MSN-4F2A): arriving 13:24 · 12 km to pickup · on E11.');
    expect(progressShareText({etaText: '13:24', remainingLabel: null, roadName: null, shortCode: null, targetLabel: 'drop-off'}))
      .toBe('Progress update: arriving 13:24.');
  });
});
