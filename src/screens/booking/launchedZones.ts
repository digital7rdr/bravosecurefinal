/**
 * B-861 — the LAUNCHED operating zones, in ONE place.
 *
 * Founder 2026-08-01: only UAE and South Africa are bookable. That list used to
 * be written out three times — `ZoneMapScreen.REGION_SEED`, the review screen's
 * `ZONES` tiles, and implicitly wherever a picker scoped itself to a country —
 * so a fourth launch would have had to find all three. The review-screen tiles
 * are gone (the zone follows the pick-up pin now); this module is what the
 * remaining surfaces read.
 *
 * It is deliberately NOT `src/utils/regions.ts`: that file is the canonical
 * list of every region the STACK knows (BD/GB/SA included, because a device can
 * sit in one). "Launched" is a product decision on top of it, and confusing the
 * two is exactly how a London pin became a bookable "hit" that the server then
 * refused as `unsupported_region`.
 */
export interface LaunchedZone {
  /** Dispatch key — `region_code` across the whole stack. DO NOT change. */
  code: string;
  /** B-90 T-07 — short DISPLAY badge ("SA" here is South Africa, code ZA). */
  label: string;
  /** Full label written to `zone_label` → create()'s `region_label`. */
  name: string;
  /** Country name for the zone tiles. */
  country: string;
  /** Pilot cities, shown as the tile sub-line. */
  cities: string;
  flag: string;
  /** B-789b — the zone's fixed UTC offset; every schedule picker reads in it. */
  utcOffsetHours: number;
}

export const LAUNCHED_ZONES: ReadonlyArray<LaunchedZone> = [
  {
    code: 'AE', label: 'UAE', name: 'UAE — Dubai, Abu Dhabi, Sharjah',
    country: 'UAE', cities: 'Dubai, Abu Dhabi, Sharjah', flag: '🇦🇪', utcOffsetHours: 4,
  },
  {
    code: 'ZA', label: 'SA', name: 'South Africa — Johannesburg, Cape Town',
    country: 'South Africa', cities: 'Johannesburg, Cape Town', flag: '🇿🇦', utcOffsetHours: 2,
  },
];

/** The launched dispatch keys — the set `zoneFromPickup` is filtered against. */
export const LAUNCHED_ZONE_CODES: ReadonlyArray<string> = LAUNCHED_ZONES.map(z => z.code);

/** The launched zone for a dispatch key, or `null` when it is not launched. */
export function launchedZone(code: string | null | undefined): LaunchedZone | null {
  if (!code) {return null;}
  const c = code.trim().toUpperCase();
  return LAUNCHED_ZONES.find(z => z.code === c) ?? null;
}

/** "UAE or South Africa" — the copy for a refusal / the pre-pin picker chip. */
export function launchedZonesLabel(): string {
  const names = LAUNCHED_ZONES.map(z => z.country);
  if (names.length <= 1) {return names[0] ?? '';}
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/**
 * B-868 P1-1 — what a header "operating zone" chip is allowed to say.
 *
 * The booking store is NOT persisted and `resetDraft` has no callers, so
 * `draft.zone_code` is the compiled seed (`LAUNCHED_ZONES[0]`) on every cold
 * start. Before a pick-up pin exists the app therefore does not KNOW the user's
 * zone — and since B-868 removed the chooser, spelling out "United Arab
 * Emirates" to a Johannesburg client would be a confident lie with no door to
 * correct it. So the chip names a zone only once a pin has derived one, and
 * otherwise states where we operate — the same rule the pick-up picker's chip
 * already follows (B-861 A7).
 */
export function zoneChipCopy(
  pinned: boolean,
  zone: {name: string; badge: string},
): {text: string; a11y: string} {
  if (pinned) {
    return {text: zone.badge, a11y: `Operating zone: ${zone.name}`};
  }
  return {
    text: LAUNCHED_ZONES.map(z => z.label).join(' · '),
    a11y: `Operating zone follows your pick-up — we operate in ${launchedZonesLabel()}`,
  };
}

/** The four draft zone fields for a derived code, plus a name for a notice. */
export interface ZoneDraftFields {
  zone_code: string;
  zone_label: string;
  region: string;
  zone_utc_offset_hours: number | null;
  /** Human name for a notice ("the service location moved to South Africa"). */
  display: string;
}

/**
 * B-868 — the four draft fields for a zone `zoneFromPickup` derived from a pin.
 *
 * A region ops launched AFTER this build has no `launchedZone()` row, so its
 * label and clock come from what the draft already carries for it. The offset is
 * KEPT, never invented: a wrong `zone_utc_offset_hours` silently books the wrong
 * hour (B-789b), and `null` already means "use the device clock" downstream.
 *
 * `CustomizeAddOnsScreen` holds its own copy of this rule (`zoneFieldsFor`,
 * pinned verbatim by `zoneFollowsPickup`) and is deliberately left alone; this
 * is the shared form the executive screens use.
 */
export function zoneDraftFields(
  code: string,
  draft: {zone_code: string; zone_label: string; zone_utc_offset_hours: number | null},
): ZoneDraftFields {
  const z = launchedZone(code);
  if (z) {
    return {
      zone_code: z.code, zone_label: z.name, region: z.code,
      zone_utc_offset_hours: z.utcOffsetHours, display: z.country,
    };
  }
  const known = code === draft.zone_code;
  return {
    zone_code: code,
    zone_label: known ? draft.zone_label : code,
    region: code,
    zone_utc_offset_hours: known ? draft.zone_utc_offset_hours : null,
    display: known && draft.zone_label ? draft.zone_label : code,
  };
}
