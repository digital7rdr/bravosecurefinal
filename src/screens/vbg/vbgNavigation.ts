/**
 * GeoRisk in-app navigation — the DECISION half (owner 2026-10-30: "GeoRisk
 * navigation must stay inside BRAVO App. currently it opens with googlemaps
 * and waze … navigation should start with voice interaction").
 *
 * Navigate on a GeoRisk key point (police, hospital, embassy, fire) used to
 * hand the coordinates to the phone (`geo:` on Android, which shows the
 * Google Maps / Waze chooser; Apple Maps on iOS). It now opens Bravo's own
 * turn-by-turn screen (VBGNavigateScreen) built on the same Mapbox route,
 * voice-cue and camera code the CPO tracker drives missions with
 * (utils/mapboxDirections, utils/navVoice, modules/maps/navCamera).
 *
 * Pure and provider-free so the timing rules are unit-tested: what is said
 * when guidance starts, when to re-route, when the trip is over.
 */
import type {DirectionsProfile, DirectionsRoute} from '@utils/mapboxDirections';
import {formatDuration} from '@utils/mapboxDirections';

/** How the person is travelling. Walking matters: a key point is often near. */
export type TravelMode = 'drive' | 'walk';

export function profileFor(mode: TravelMode): DirectionsProfile {
  return mode === 'walk' ? 'walking' : 'driving-traffic';
}

/** Below this straight-line distance the screen offers Walk first. */
export const WALK_DEFAULT_MAX_M = 1200;

export function defaultModeFor(straightLineM: number): TravelMode {
  return Number.isFinite(straightLineM) && straightLineM <= WALK_DEFAULT_MAX_M ? 'walk' : 'drive';
}

/** Farther than this from the line counts as off route (metres). */
export const OFF_ROUTE_M = 60;
/** Never fetch a new route more often than this while off route. */
export const REROUTE_MIN_GAP_MS = 8000;
/** A fix with worse accuracy than this cannot prove the person left the route. */
export const MAX_ACCURACY_FOR_REROUTE_M = 50;

/**
 * Whether to fetch a new route now. A single noisy fix must not re-route:
 * the fix has to be accurate enough to trust, clearly off the line, and the
 * last fetch must be a few seconds old (a fetch already running wins).
 */
export function shouldReroute(input: {
  offRouteM: number; accuracyM: number | null; nowMs: number; lastFetchMs: number; inFlight: boolean;
}): boolean {
  const {offRouteM, accuracyM, nowMs, lastFetchMs, inFlight} = input;
  if (inFlight) {return false;}
  if (!Number.isFinite(offRouteM) || offRouteM <= OFF_ROUTE_M) {return false;}
  if (accuracyM !== null && accuracyM > MAX_ACCURACY_FOR_REROUTE_M) {return false;}
  return nowMs - lastFetchMs >= REROUTE_MIN_GAP_MS;
}

/** Within this many metres (along the route) of the destination = arrived. */
export const ARRIVED_M = 30;

export function hasArrived(remainingM: number, straightLineM: number): boolean {
  return remainingM <= ARRIVED_M || straightLineM <= ARRIVED_M;
}

function km(m: number): string {
  if (m < 1000) {return `${Math.max(10, Math.round(m / 10) * 10)} metres`;}
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} kilometres`;
}

/**
 * The first thing guidance says — spoken the moment Start is tapped, so the
 * person hears that navigation is running before the first turn is due:
 * "Starting navigation to Al Barsha Police Station. 4.2 kilometres, about
 * 9 min. Head north on Al Khail Road."
 */
export function startAnnouncement(route: DirectionsRoute, destinationLabel: string, mode: TravelMode): string {
  const where = destinationLabel.trim() || 'your destination';
  const verb = mode === 'walk' ? 'Walking directions' : 'Starting navigation';
  const first = route.steps[0];
  const firstLine = (first?.voice[0]?.announcement || first?.instruction || '').trim();
  const parts = [
    `${verb} to ${where}.`,
    `${km(route.distanceM)}, about ${formatDuration(route.durationS)}.`,
  ];
  if (firstLine) {parts.push(firstLine.endsWith('.') ? firstLine : `${firstLine}.`);}
  return parts.join(' ');
}

export function arrivalAnnouncement(destinationLabel: string): string {
  const where = destinationLabel.trim();
  return where ? `You have arrived at ${where}.` : 'You have arrived.';
}

export const REROUTE_ANNOUNCEMENT = 'Re-routing.';

/** Arrival time as the person's wall clock, e.g. "14:35". */
export function arrivalClock(nowMs: number, remainingS: number): string {
  const d = new Date(nowMs + Math.max(0, remainingS) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Remaining duration, scaled by the share of the route still ahead. */
export function remainingSeconds(route: DirectionsRoute, remainingM: number): number {
  if (route.distanceM <= 0) {return 0;}
  return Math.round(route.durationS * Math.min(1, Math.max(0, remainingM / route.distanceM)));
}
