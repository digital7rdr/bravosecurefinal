/**
 * Canonical supported-region list — the SINGLE source of truth for `region_code`
 * across dispatch matching, agency profile, booking, and compliance.
 *
 * Previously forked 5 ways (constants.ts / booking.service / agent.service /
 * OrgComplianceScreen / ZoneMapScreen), which let a 'ZA' actor be SILENTLY
 * un-rankable (constants had ZA; the dispatch allow-list didn't). Add a region
 * HERE and re-export — never re-declare a region list elsewhere.
 *
 * ZA (South Africa) is supported per the 2026-06-25 product decision. Its ZAR
 * currency + FX rate are config values gated SEPARATELY from region matching:
 * a 'ZA' agency/booking dispatches fine on region alone; ZAR pricing/escrow is a
 * finance-signed follow-up.
 */
export interface RegionDef {
  code: string;
  name: string;
  currency: string;
  /** LM-M2 — standard UTC offset (hours) for local-wall-clock rules like the
   *  peak-pricing window. Deliberately DST-naive: an hour of drift twice a year
   *  in GB beats the old behaviour (peak evaluated in raw UTC everywhere). */
  utcOffsetHours: number;
  /**
   * B-93 — PRODUCT launch flag: is this region OPEN for client bookings?
   * Availability used to be derived from `cpo_pool` counts, which kept a
   * launched-but-not-yet-staffed region (ZA) stuck on "COMING SOON" and
   * would flash a live region "unavailable" if its pool ever hit zero.
   * Launched-with-no-supply bookings still work: the ops-review path is
   * handled manually and auto-dispatch degrades to NO_PROVIDER.
   */
  launched: boolean;
  /**
   * Rough extent used to DERIVE a booking's region from its pickup coordinates.
   *
   * Load-bearing for per-region pricing: `region` arrives on the create DTO from
   * the CLIENT, so pricing on it would let anyone name the cheapest region and
   * pay its rate — the same hole 20260831180000 refused to open for lead time.
   * Undefined means "cannot be resolved from coordinates", which prices at the
   * global rate. Never the reverse: an un-boxed region can decline to change a
   * price, it can never make one cheaper.
   */
  bbox?: {minLat: number; maxLat: number; minLng: number; maxLng: number};
  /**
   * B-788a — how this region routes offers. 'nearest' = the Uber-style radius
   * ranker (today, byte-identical); 'assigned' = the ops-set primary/secondary
   * provider ladder per operational area, no radius. Undefined on the compiled
   * seed and on rows that predate the column → the process default applies.
   */
  routingMode?: 'nearest' | 'assigned';
}

/**
 * The COMPILED fallback — what this service knows with no database.
 *
 * Since 2026-09-01 regions are ops-managed rows (`public.regions`); this array is
 * the seed those rows were created from and the fail-open answer when the table
 * is unreachable. Read `regions()`, never this, or an ops-added region is
 * invisible to your code path.
 */
export const DEFAULT_REGIONS: ReadonlyArray<RegionDef> = [
  {code: 'AE', name: 'UAE — Dubai, Abu Dhabi, Sharjah',         currency: 'AED', utcOffsetHours: 4, launched: true},
  {code: 'SA', name: 'Saudi Arabia — Riyadh, Jeddah',           currency: 'SAR', utcOffsetHours: 3, launched: false},
  {code: 'BD', name: 'Bangladesh — Dhaka Division',             currency: 'BDT', utcOffsetHours: 6, launched: true},
  {code: 'GB', name: 'United Kingdom — London',                 currency: 'GBP', utcOffsetHours: 0, launched: false},
  {code: 'ZA', name: 'South Africa — Johannesburg, Cape Town',  currency: 'ZAR', utcOffsetHours: 2, launched: true},
];

/**
 * The live set, replaced by `RegionsService` from `public.regions`.
 *
 * A module-level cache read SYNCHRONOUSLY at call time, which is what lets every
 * existing consumer keep its signature — the alternative was making
 * `regionUtcOffsetHours` async and rippling through the quote path. Same shape
 * as the client's `servicePricingOverrides`, for the same reason.
 */
let live: ReadonlyArray<RegionDef> | null = null;

/**
 * Publish the ops-managed rows. `null` (or an EMPTY array) reverts to the
 * compiled set: an empty region table would fail every `unsupported_region`
 * check and take bookings down product-wide, so it is treated as "no data",
 * never as "no regions exist".
 */
export function setLiveRegions(rows: ReadonlyArray<RegionDef> | null | undefined): void {
  live = rows && rows.length > 0 ? rows : null;
}

/** Every region this service dispatches in, ops rows when loaded. */
export function regions(): ReadonlyArray<RegionDef> {
  return live ?? DEFAULT_REGIONS;
}

/** UTC offset for a region code (0 when unknown — falls back to UTC). */
export function regionUtcOffsetHours(code: string | null | undefined): number {
  const r = regions().find(x => x.code === (code ?? '').trim().toUpperCase());
  return r?.utcOffsetHours ?? 0;
}

/** Region codes a dispatchable actor (agency / booking) may carry. */
export function supportedRegionCodes(): ReadonlyArray<string> {
  return regions().map(r => r.code);
}

/**
 * The region a POINT falls in, or null.
 *
 * The server-derived answer per-region pricing is priced on. Boxes do not
 * overlap in this product; if they ever did, the first match wins and ops has a
 * data error to fix — which is visible and correctable, unlike trusting the
 * client's own region code.
 */
export function regionFromPoint(lat: number | null | undefined, lng: number | null | undefined): string | null {
  if (typeof lat !== 'number' || typeof lng !== 'number') {return null;}
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {return null;}
  const hit = regions().find(r =>
    r.bbox && lat >= r.bbox.minLat && lat <= r.bbox.maxLat
           && lng >= r.bbox.minLng && lng <= r.bbox.maxLng);
  return hit?.code ?? null;
}

/** The region's box, or null when none is loaded (the compiled seed carries none). */
export function regionBox(code: string | null | undefined): RegionDef['bbox'] | null {
  const r = regions().find(x => x.code === (code ?? '').trim().toUpperCase());
  return r?.bbox ?? null;
}

/**
 * B-788b — is a point inside THIS region's box?
 *
 * `null` when the region has no box (unknown). Callers FAIL OPEN on null: a
 * box is data, and "no data" must never refuse every booking in a region —
 * the compiled fallback set, used whenever public.regions is unreachable,
 * carries no boxes at all.
 */
export function isInsideRegionBox(
  code: string | null | undefined,
  lat: number | null | undefined,
  lng: number | null | undefined,
): boolean | null {
  const box = regionBox(code);
  if (!box) {return null;}
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return false;
  }
  return lat >= box.minLat && lat <= box.maxLat && lng >= box.minLng && lng <= box.maxLng;
}

/** Sentinel for a person outside every supported region. Never dispatchable. */
export const REGION_NA = 'N/A';

/** ISO-3166 alpha-2 country → region_code, for reverse-geocode region detection. */
export const COUNTRY_TO_REGION: Record<string, string> = {
  AE: 'AE', SA: 'SA', BD: 'BD', GB: 'GB', ZA: 'ZA',
};

/**
 * Map a reverse-geocoded country code to a region, or N/A if outside coverage.
 *
 * Falls through to the LIVE region codes after the explicit map, so a region
 * added in ops resolves on its own ISO-3166 code without anyone remembering to
 * edit a second table. The explicit map stays for the case the identity rule
 * cannot express: one region covering several countries.
 */
export function regionFromCountry(iso2: string | null | undefined): string {
  if (!iso2) {return REGION_NA;}
  const code = iso2.trim().toUpperCase();
  if (COUNTRY_TO_REGION[code]) {return COUNTRY_TO_REGION[code];}
  return regions().some(r => r.code === code) ? code : REGION_NA;
}

export function isSupportedRegion(code: string | null | undefined): boolean {
  return !!code && supportedRegionCodes().includes(code.trim().toUpperCase());
}
