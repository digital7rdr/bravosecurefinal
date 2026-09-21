import {Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {ConfigVersionMirror} from './services/config-version';
import {DEFAULT_REGIONS, setLiveRegions, type RegionDef} from './regions';

/** Same 60 s window PricingService uses — an ops edit lands on the next minute. */
const REGIONS_TTL_MS = 60_000;
/**
 * OP-05 — a pod that serves no booking traffic never called `ensureFresh()`,
 * so its synchronous readers (agent region validation) sat on the compiled
 * defaults indefinitely. A background tick bounds that: every pod converges
 * within one tick even with zero traffic, and the cluster version check
 * inside `ensureFresh` makes an ops write land within 2 s on busy pods.
 */
const BACKGROUND_REFRESH_MS = 30_000;

interface RegionRow {
  code: string;
  name: string;
  currency: string;
  utc_offset_hours: string | number;
  launched: boolean;
  min_lat: string | number | null;
  max_lat: string | number | null;
  min_lng: string | number | null;
  max_lng: string | number | null;
  routing_mode: string | null;
}

/**
 * Loads ops-managed regions from `public.regions` into the module-level cache
 * that `regions()` reads synchronously.
 *
 * ── Why a publish-into-a-module-cache, and not an async getter ──────────────
 *
 * `regionUtcOffsetHours` is called from inside the price calculation, and
 * `supportedRegionCodes` from validation paths several layers down. Making those
 * async would have rippled through the whole quote path for a five-row lookup.
 * Instead this service owns the refresh and publishes; readers stay synchronous.
 * The client mirror (`servicePricingOverrides`) is the same pattern.
 *
 * ── Fail-open, in the one direction that is safe ────────────────────────────
 *
 * Any failure — unreachable table, migration not yet applied, malformed row —
 * leaves the previously published set in place, falling back to the compiled
 * `DEFAULT_REGIONS`. An EMPTY result is treated as "no data" rather than "no
 * regions": publishing an empty list would fail every `unsupported_region`
 * check and stop bookings product-wide, which is a far worse outcome than
 * briefly missing a newly added region.
 *
 * ── OP-05: boot load + cluster version + background tick ────────────────────
 *
 * The write path's `refresh()` only ever fixed the pod that served the write.
 * Now every ops write also bumps `cfgver:regions` in shared Redis, `ensureFresh`
 * reloads when that number moved (2 s mirror), the set is loaded at boot, and a
 * 30 s tick keeps idle pods within one interval. Redis-less environments keep
 * the plain 60 s TTL behaviour.
 */
@Injectable()
export class RegionsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(RegionsService.name);
  private loadedAt = 0;
  private inFlight: Promise<void> | null = null;
  private readonly version = new ConfigVersionMirror('regions');
  private loadedVersion: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  // @Optional so the many specs that construct collaborators bare keep working
  // with the compiled defaults, exactly like PricingService.
  constructor(
    @Optional() private readonly db?: DatabaseService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  // OnApplicationBootstrap, not OnModuleInit: module init order is not
  // guaranteed across modules, and on the staging box the first boot load ran
  // BEFORE DatabaseService had created its pool ("Cannot read properties of
  // undefined (reading 'query')" — fail-open to the compiled set until the
  // first tick). The bootstrap hook runs after EVERY module's init.
  onApplicationBootstrap(): void {
    if (!this.db) {return;}
    this.log.log('regions boot-load (post-bootstrap) armed');
    void this.ensureFresh();
    // unref: never keep a shutting-down process alive for a cache tick.
    this.timer = setInterval(() => { void this.ensureFresh(); }, BACKGROUND_REFRESH_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {clearInterval(this.timer); this.timer = null;}
  }

  /**
   * Refresh if the cache is older than the TTL OR the cluster version moved.
   * Call from any async path that is about to read regions — booking create,
   * the regions endpoint, agent region validation. Single-flighted: a burst of
   * concurrent bookings triggers one query, not one each.
   */
  async ensureFresh(): Promise<void> {
    const ver = await this.version.current(this.redis);
    const versionMoved = ver !== null && ver !== this.loadedVersion;
    if (!versionMoved && Date.now() - this.loadedAt < REGIONS_TTL_MS) {return;}
    if (this.inFlight) {return this.inFlight;}
    this.inFlight = this.load(ver).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /** Force a reload — used right after an ops write so the author sees their edit. */
  async refresh(): Promise<void> {
    this.loadedAt = 0;
    await this.ensureFresh();
  }

  private async load(version: number | null): Promise<void> {
    if (!this.db) {return;}
    try {
      const rows = await this.db.q<RegionRow>(
        `SELECT code, name, currency, utc_offset_hours, launched,
                min_lat, max_lat, min_lng, max_lng,
                -- B-788a — read through jsonb so a server ahead of the areas
                -- migration still loads every ops-created region (a missing
                -- column here would silently drop them all to the compiled set).
                (to_jsonb(regions) ->> 'routing_mode') AS routing_mode
           FROM public.regions
          ORDER BY code`,
      );
      const mapped = rows.map(r => RegionsService.toDef(r)).filter((r): r is RegionDef => r !== null);
      // Stamp the time only on a SUCCESSFUL read. A failed load must retry on the
      // next call rather than sit on the compiled set for a full TTL.
      this.loadedAt = Date.now();
      this.loadedVersion = version;
      setLiveRegions(mapped);
    } catch (e) {
      this.log.warn(`regions read failed, using ${DEFAULT_REGIONS.length} compiled regions: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * One row → one RegionDef, or null if the row cannot be trusted.
   *
   * node-postgres hands `numeric` back as a STRING, so every coordinate and the
   * UTC offset go through Number() — a string offset would make every peak-hour
   * comparison in the quote silently wrong. A row missing a code or name is
   * dropped rather than published half-formed.
   */
  private static toDef(r: RegionRow): RegionDef | null {
    const code = (r.code ?? '').trim().toUpperCase();
    const name = (r.name ?? '').trim();
    if (!code || !name) {return null;}

    const offset = Number(r.utc_offset_hours);
    const box = [r.min_lat, r.max_lat, r.min_lng, r.max_lng].map(v => (v === null ? null : Number(v)));
    const hasBox = box.every(v => typeof v === 'number' && Number.isFinite(v));

    return {
      code,
      name,
      currency: (r.currency ?? '').trim().toUpperCase(),
      utcOffsetHours: Number.isFinite(offset) ? offset : 0,
      launched: !!r.launched,
      // B-788a — only the two real modes; anything else routes as today.
      ...(r.routing_mode === 'assigned' || r.routing_mode === 'nearest' ? {routingMode: r.routing_mode} : {}),
      ...(hasBox
        ? {bbox: {
            minLat: box[0] as number, maxLat: box[1] as number,
            minLng: box[2] as number, maxLng: box[3] as number,
          }}
        : {}),
    };
  }
}
