/**
 * Navigation camera (Navigation Ver 2, 2026-10-16).
 *
 * Founder: "the navigation does not get zoomed in as we approach the
 * location." Both map renderers set the follow zoom ONCE (16 / 16.5) and never
 * moved it again, so a driver approaching a turn or the destination saw the
 * same wide frame as on the motorway. Waze and Google Maps do the opposite:
 * wide and fast on the open road, tight and slow at a turn, tightest on
 * arrival.
 *
 * ONE pure function decides the zoom + pitch for a fix so the WebView map and
 * the native map cannot disagree, and so the rule is unit-tested. Inputs are
 * what the tracker already knows at 1 Hz: speed, distance to the next
 * maneuver, distance to the destination, orientation mode.
 *
 * Zoom levels are Mapbox GL zooms (16 ≈ a few blocks, 18 ≈ one junction).
 */

export type NavCamMode = 'course' | 'north';

export interface NavCamInput {
  /** Vehicle speed in km/h; null when the fix carries none. */
  speedKph: number | null;
  /** Metres to the next maneuver; null when there is no route. */
  distToManeuverM: number | null;
  /** Metres left to the destination along the route; null when unknown. */
  distToDestinationM: number | null;
  mode: NavCamMode;
}

export interface NavCamFrame {
  zoom: number;
  pitch: number;
}

/** Below this, the destination is "here": flat, tight, the pin and the puck. */
export const ARRIVAL_M = 60;

export const NAV_PITCH = 55;
const ARRIVAL_PITCH = 30;

/** Open-road zoom from speed (course-up). Slower = closer. */
function zoomForSpeed(speedKph: number | null): number {
  if (speedKph === null) {return 16.5;}
  if (speedKph < 20) {return 17.5;}
  if (speedKph < 50) {return 17;}
  if (speedKph < 80) {return 16.5;}
  if (speedKph < 110) {return 16;}
  return 15.5;
}

/** The zoom a turn deserves as it gets close, or 0 when it is far. */
function zoomForManeuver(distM: number | null): number {
  if (distM === null) {return 0;}
  if (distM <= 120) {return 18;}
  if (distM <= 300) {return 17.5;}
  if (distM <= 600) {return 17;}
  return 0;
}

/** The zoom the destination deserves as it gets close, or 0 when it is far. */
function zoomForDestination(distM: number | null): number {
  if (distM === null) {return 0;}
  if (distM <= ARRIVAL_M) {return 18.5;}
  if (distM <= 200) {return 18;}
  if (distM <= 500) {return 17.5;}
  if (distM <= 1000) {return 17;}
  return 0;
}

/**
 * The frame for this fix. Closeness wins over speed (a turn at 100 km/h is
 * still a turn), north-up sits half a level wider (the road ahead is not
 * screen-up, so the driver needs context in every direction), and arrival
 * flattens the pitch so the pin and the kerb are readable.
 */
export function navCameraFor(input: NavCamInput): NavCamFrame {
  const base = zoomForSpeed(input.speedKph);
  let zoom = Math.max(base, zoomForManeuver(input.distToManeuverM), zoomForDestination(input.distToDestinationM));
  if (input.mode === 'north') {zoom -= 0.5;}
  const arriving = input.distToDestinationM !== null && input.distToDestinationM <= ARRIVAL_M;
  const pitch = input.mode === 'north' ? 0 : arriving ? ARRIVAL_PITCH : NAV_PITCH;
  return {zoom: Math.min(18.5, Math.max(14, zoom)), pitch};
}

/**
 * Hysteresis: at 1 Hz the inputs wobble (GPS speed ±3 km/h), and a camera that
 * breathes a quarter-level every second is worse than a fixed one. Move only
 * when the target differs by at least this much from where the camera was
 * last SENT — then move all the way.
 */
export const ZOOM_STEP = 0.4;

export function shouldRetarget(prev: NavCamFrame | null, next: NavCamFrame): boolean {
  if (!prev) {return true;}
  return Math.abs(next.zoom - prev.zoom) >= ZOOM_STEP - 1e-9 || next.pitch !== prev.pitch;
}

/** The line the "Share progress" button posts into the mission group. */
export function progressShareText(input: {
  etaText: string; remainingLabel: string | null; roadName: string | null; shortCode: string | null;
  targetLabel: 'pickup' | 'drop-off';
}): string {
  const where = input.roadName ? ` · on ${input.roadName}` : '';
  const left = input.remainingLabel ? ` · ${input.remainingLabel} to ${input.targetLabel}` : '';
  const code = input.shortCode ? ` (${input.shortCode})` : '';
  return `Progress update${code}: arriving ${input.etaText}${left}${where}.`;
}
