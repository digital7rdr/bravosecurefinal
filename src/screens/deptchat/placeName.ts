/**
 * "Where was this check-in?" answered in words, not in decimals.
 *
 * Founder, 2026-09-05, on a check-in card reading `23.83167, 90.38008` twice:
 * _"who can understand this coordinate? please make it human readable"_.
 *
 * The server DOES reverse-geocode a check-in — `clock_in_place` is filled by
 * `AttendanceService.geocodePlace` — but only from 2026-09-05 onward and only
 * when the auth-service has a Mapbox token and the call succeeds. Every check-in
 * recorded before that column existed has NULL, and `placeLabel()` then falls
 * back to a coordinate string. So the raw fix is not an edge case: it is the
 * whole of the history, and it is what the founder is looking at.
 *
 * This module resolves the missing name on the client, from the same fix, using
 * the token already baked into the app. Three properties make that safe to call
 * from a list row:
 *
 *   * CACHED per ~11 m grid cell for the process lifetime, so twenty rows at one
 *     site cost ONE request.
 *   * DEDUPED in flight, so a list that mounts twenty rows in one frame does not
 *     fire twenty identical requests.
 *   * a MISS IS CACHED too (as null), so a site Mapbox cannot name is asked
 *     about once, not on every re-render.
 *
 * No coordinate or address is ever logged (the property `geo.ts` already holds).
 */
import {useEffect, useState} from 'react';

import {reverseGeocodeStrict} from './geo';

/** The coordinate rendered the way `placeLabel()` renders it. */
export function coordText(lat: number, lng: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/**
 * A signed decimal pair read as a compass bearing — "23.83167° N, 90.38008° E".
 *
 * Not a translation into words, and not meant to be: it is the precise fix,
 * kept because a manager escalating an incident needs the exact number. The
 * hemisphere letters are the small courtesy that stops a negative sign being
 * the only thing distinguishing Johannesburg from Cairo.
 */
export function coordHuman(lat: number, lng: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(5)}° ${ns}, ${Math.abs(lng).toFixed(5)}° ${ew}`;
}

/**
 * True when a stored "place" is really just a coordinate pair.
 *
 * Guards the case that produced the founder's screenshot: a caller passing
 * `placeLabel()`'s coordinate fallback into a slot meant for a NAME, so the card
 * printed the same numbers twice. Accepts the exact shape we emit and the
 * common hand-typed variants (no space, extra spaces).
 */
export function isCoordText(s: string | null | undefined): boolean {
  const t = (s ?? '').trim();
  if (!t) {return false;}
  return /^-?\d{1,3}(\.\d+)?\s*,\s*-?\d{1,3}(\.\d+)?$/.test(t);
}

/** A usable fix — finite, in range, and not the 0,0 null island. */
export function validFix(lat: number | null | undefined, lng: number | null | undefined): boolean {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

/**
 * ~11 m grid. Two fixes from the same doorway share a cell (and therefore one
 * request); two neighbouring buildings do not, so a cached name never migrates
 * onto the site next door.
 */
function cellKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

const cache = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

/** Test seam — a suite must not inherit another suite's cached answers. */
export function __resetPlaceCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * The place name for a fix. `null` when there is no usable fix, no token, or
 * Mapbox has nothing — callers then show the coordinate, which is still true,
 * just not friendly.
 */
export async function resolvePlaceName(lat: number, lng: number): Promise<string | null> {
  if (!validFix(lat, lng)) {return null;}
  const key = cellKey(lat, lng);
  if (cache.has(key)) {return cache.get(key) ?? null;}
  const pending = inFlight.get(key);
  if (pending) {return pending;}

  // The STRICT variant on purpose (critic finding): the lenient `reverseGeocode`
  // returns null for offline / 429 / no-token as well as for "no name here", and
  // a cache cannot tell those apart — one flaky moment would have pinned
  // "unavailable" on every row at that site for the process lifetime.
  const run = reverseGeocodeStrict(lat, lng)
    .then(name => {
      const clean = (name ?? '').trim();
      // A geocoder that hands back the coordinate has not named anything.
      const value = clean && !isCoordText(clean) ? clean : null;
      cache.set(key, value);
      return value;
    })
    .catch(() => {
      // A thrown error is NOT cached: the next mount (back on signal) may try
      // again. A resolved null IS cached — that is Mapbox saying "no name
      // here", which will not change.
      return null;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, run);
  return run;
}

/**
 * A Mapbox `place_name` as a person would say it.
 *
 * B-806 — the raw string is a comma-separated hierarchy that ends in the
 * country, and in a multi-script country it repeats itself. The founder's own
 * check-in came back as:
 *
 *   "Turag, Dhaka, ঢাকা, Dhaka, Bangladesh"     — Dhaka three times, one Bengali
 *
 * The repo's existing `shortPlaceLabel` cannot clean that: its drop-list is
 * Gulf-country-only so "Bangladesh" survives, and its de-dup only removes
 * ADJACENT repeats so the split "Dhaka … ঢাকা … Dhaka" survives. Rather than
 * grow a country list that is wrong for the next market, this works off the
 * SHAPE of the field, which Mapbox documents:
 *
 *   1. Drop any component with no Latin letters. In an English UI a Bengali or
 *      Arabic duplicate of the next component is noise, and it is exactly what
 *      makes the string look broken. (`@utils/placeLabel` takes the same view.)
 *   2. Drop a component that repeats an earlier one, case-insensitively,
 *      ANYWHERE — not just adjacent.
 *   3. Drop the last component when three or more remain: `place_name` always
 *      ends in the country, and nobody reading their own org's attendance needs
 *      telling which country it is in.
 *
 * Everything degrades to the raw string rather than to nothing: an address that
 * is entirely non-Latin keeps all its parts, because a name in the wrong script
 * still beats a blank.
 */
export function cleanPlaceName(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  if (!text) {return '';}

  const parts = text.split(',').map(p => p.trim()).filter(Boolean);
  // `parts[0]`, not `text`: the server truncates a long name at 200 chars and
  // can land on a comma, so the raw string may carry dangling punctuation.
  if (parts.length <= 1) {return parts[0] ?? '';}

  // THE COUNTRY GOES FIRST, before any other rule. Dropping it later meant that
  // when the country was the only Latin-script component the script filter
  // deleted everything else and the country was all that survived:
  //   "সাভার, ঢাকা, Bangladesh"            → "Bangladesh"
  //   "Аргентинская улица, Москва, Russia" → "Russia"
  // i.e. the exact "plus the country" noise this function exists to remove,
  // amplified into the whole answer.
  const body = parts.length >= 3 ? parts.slice(0, -1) : parts;

  // Digits are script-neutral: a bare house number ("100", "12") carries no
  // Latin letters but is the most useful token on the line for a reviewer.
  const hasLatin = (p: string) => /[A-Za-z0-9]/.test(p);
  const anyLatin = body.some(p => /[A-Za-z]/.test(p));
  /**
   * The local-script rule, narrowed after the edge review.
   *
   * A blanket "drop every non-Latin component" deleted the MOST SPECIFIC part
   * of an address in every non-Latin country, because that is exactly the part
   * Mapbox returns in the local script:
   *
   *   "Тверская улица, Москва, Russia"  →  "Russia"     ← the whole location
   *   "Ερμού 10, Αθήνα, Greece"         →  "Greece"
   *
   * — which is worse than the noise it was meant to remove. So a non-Latin
   * component is dropped only when it is NOT the leading (most specific) one
   * AND some other component is Latin: that is the founder's actual case, a
   * local-script duplicate of the city sitting mid-string, and it leaves the
   * street alone. `language=en` on the geocoder (see `geo.ts`) means new
   * lookups rarely produce one at all; this handles what is already stored.
   */
  const kept = body.filter((p, i) => i === 0 || !anyLatin || hasLatin(p));

  const seen = new Set<string>();
  const unique = kept.filter(p => {
    // NFKD-fold the key: Turkish 'İ'.toLowerCase() is 'i' + a combining dot, so
    // "İstanbul" never matched "Istanbul" and the duplicate survived.
    const key = p.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
    if (seen.has(key)) {return false;}
    seen.add(key);
    return true;
  });

  // No second trim: the country came off at the top, so everything here is a
  // level someone might actually need. Trimming again ate the city of a place
  // whose name equals its country ("Rue du Fossé, Luxembourg, Luxembourg").
  return (unique.length > 0 ? unique : parts).join(', ');
}

export type PlaceStatus =
  /** The server already stored a real name — nothing was fetched. */
  | 'stored'
  /** Resolving it now from the fix. */
  | 'resolving'
  /** Resolved on the client from the fix. */
  | 'resolved'
  /** There is a fix, but nobody can name it — show the coordinate. */
  | 'unavailable'
  /** No usable fix at all. */
  | 'none';

/**
 * The display name for a check-in, resolving it from the fix when the server
 * did not store one.
 *
 * `stored` is the server's `clock_in_place`. A coordinate string there is
 * treated as ABSENT, not as a name — that is the whole defect this fixes.
 */
export function useResolvedPlace(
  stored: string | null | undefined,
  lat: number | null | undefined,
  lng: number | null | undefined,
): {name: string | null; status: PlaceStatus} {
  const storedName = (stored ?? '').trim();
  const haveStored = storedName.length > 0 && !isCoordText(storedName);
  const canResolve = !haveStored && validFix(lat, lng);
  const key = canResolve ? cellKey(lat as number, lng as number) : '';
  // Seed from the cache so a row that scrolls back into view paints the name on
  // its FIRST frame instead of flashing "Finding…" again. The answer is stored
  // WITH the cell it answers, so a fix that changes under a mounted component
  // can never show the previous cell's name for a frame.
  const [answer, setAnswer] = useState<{key: string; value: string | null} | null>(() =>
    canResolve && cache.has(key) ? {key, value: cache.get(key) ?? null} : null,
  );

  useEffect(() => {
    if (!canResolve) {return;}
    if (cache.has(key)) {
      setAnswer({key, value: cache.get(key) ?? null});
      return;
    }
    let alive = true;
    void resolvePlaceName(lat as number, lng as number).then(value => {
      if (alive) {setAnswer({key, value});}
    });
    return () => {
      alive = false;
    };
  }, [canResolve, key, lat, lng]);

  if (haveStored) {return {name: storedName, status: 'stored'};}
  if (!canResolve) {return {name: null, status: 'none'};}
  const resolved = answer && answer.key === key ? answer.value : undefined;
  if (resolved === undefined) {return {name: null, status: 'resolving'};}
  if (resolved === null) {return {name: null, status: 'unavailable'};}
  return {name: resolved, status: 'resolved'};
}

/** Metres between two fixes — equirectangular, which is exact enough at site scale. */
export function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const midLat = ((aLat + bLat) / 2) * Math.PI / 180;
  const x = dLng * Math.cos(midLat);
  return Math.round(Math.sqrt(dLat * dLat + x * x) * R);
}

/** "180 m" / "1.4 km" — a distance a person reads without converting. */
export function distanceText(metres: number): string {
  if (!Number.isFinite(metres) || metres < 0) {return '';}
  if (metres < 1000) {return `${metres} m`;}
  return `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`;
}
