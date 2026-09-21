import type {DatabaseService} from '../database/database.service';
import {regions} from './regions';

/**
 * B-788a — operational AREAS (province-level routing partitions under a region).
 *
 * Kept in `common/` deliberately: BookingService stamps `area_id` at create and
 * DispatchService resolves it when routing, and the two modules must not import
 * each other (DispatchModule already imports BookingModule). A pure function
 * that takes the db handle is what both can call without a cycle.
 */

export type RoutingMode = 'nearest' | 'assigned';

/**
 * The area a point falls in inside a region: the first ACTIVE drawn area whose
 * box contains it (oldest first — boxes may overlap at province borders), else
 * the region's default (catch-all) area, else null when the region has no
 * areas at all (a region seeded before the areas migration ran).
 *
 * Reads the DB directly — one indexed query per booking create / dispatch pass,
 * and never cached, so an ops edit routes the very next offer.
 */
export async function areaIdForPoint(
  db: Pick<DatabaseService, 'qOne'>,
  regionCode: string | null | undefined,
  lat: number | null | undefined,
  lng: number | null | undefined,
): Promise<string | null> {
  const region = (regionCode ?? '').trim().toUpperCase();
  if (!region) {return null;}
  const hasPoint = typeof lat === 'number' && typeof lng === 'number'
    && Number.isFinite(lat) && Number.isFinite(lng);
  const row = await db.qOne<{id: string}>(
    `SELECT id
       FROM public.operational_areas
      WHERE region_code = $1 AND active = TRUE
        AND (
          is_default = TRUE
          OR ($2::boolean AND min_lat IS NOT NULL
              AND $3::numeric BETWEEN min_lat AND max_lat
              AND $4::numeric BETWEEN min_lng AND max_lng)
        )
      ORDER BY is_default ASC, created_at ASC
      LIMIT 1`,
    [region, hasPoint, hasPoint ? lat : 0, hasPoint ? lng : 0],
  );
  return row?.id ?? null;
}

/**
 * How a region routes: its own ops-set `routing_mode`, else the process default
 * (`DISPATCH_ROUTING_MODE`, itself defaulting to 'nearest'). 'nearest' is the
 * byte-identical pre-B-788a ranker, which is what keeps this dark until ops
 * flips a region.
 */
export function regionRoutingMode(
  regionCode: string | null | undefined,
  processDefault: RoutingMode,
): RoutingMode {
  const r = regions().find(x => x.code === (regionCode ?? '').trim().toUpperCase());
  return r?.routingMode ?? processDefault;
}

export function parseRoutingMode(raw: string | undefined | null): RoutingMode {
  return raw === 'assigned' ? 'assigned' : 'nearest';
}

/** The process-wide routing default (DISPATCH_ROUTING_MODE), read per call so a
 *  spec can flip it with a module reset. */
export function routingModeDefault(): RoutingMode {
  return parseRoutingMode(process.env.DISPATCH_ROUTING_MODE);
}

/** Every region that currently routes by assigned provider — the surfaces that
 *  still carry a radius (the job-portal feed) drop it for these. */
export function assignedRoutingRegionCodes(processDefault: RoutingMode = routingModeDefault()): string[] {
  return regions()
    .filter(r => regionRoutingMode(r.code, processDefault) === 'assigned')
    .map(r => r.code);
}
