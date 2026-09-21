/**
 * B-794 — the "last known location" a user detail page may show.
 *
 * Its own module rather than a shape inside `api.ts` for two reasons: the
 * normaliser below is the only safe way to read the field and needs to be
 * unit-testable (api.ts pulls the whole fetch/auth stack and cannot be imported
 * in a node test), and keeping the union next to the guard makes it hard to
 * hand-roll the narrowing somewhere else.
 *
 * The server decides WHAT ops may see — each source re-checks the consent basis
 * governing its own write path, so a user who narrows Settings -> Location
 * disappears from here too. This file only decides how to read the answer.
 */

export type OpsUserLocation =
  | {
    lat: number; lng: number; recorded_at: string;
    /** family = continuous share, agent = on-duty CPO, vbg = active monitoring. */
    source: 'family' | 'agent' | 'vbg';
    accuracy_m: number | null; label: string | null;
  }
  | {blocked: 'opted_out' | 'no_source'};

/**
 * Normalise whatever the API returned into the union the UI renders.
 *
 * The console and the auth-service deploy separately, so a console shipped
 * first talks to an API that has never heard of this field. An absent value is
 * indistinguishable from "nothing on record" to a viewer and safe to show; what
 * is NOT safe is the component's `'blocked' in location` narrowing running on
 * `undefined`, which throws and blanks the entire user page rather than one row.
 */
export function resolveUserLocation(loc: OpsUserLocation | null | undefined): OpsUserLocation {
  if (!loc || typeof loc !== 'object') return {blocked: 'no_source'};
  if ('blocked' in loc) return loc;
  // Coordinates that arrived as strings or NULLs would render "NaN, NaN" and
  // read as a real position.
  return Number.isFinite(loc.lat) && Number.isFinite(loc.lng) ? loc : {blocked: 'no_source'};
}
