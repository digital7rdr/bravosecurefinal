import {Injectable, Logger, Optional} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {ConfigVersionMirror} from '../common/services/config-version';
import {regionUtcOffsetHours} from '../common/regions';

/**
 * Pricing calculator for Lite bookings.
 *
 * Base rate: 1 CPO + 1 Vehicle + 1 Driver = EUR 86/hr (≈ AED 350/hr).
 * Extra CPOs / vehicles above baseline: +25% of base per additional unit.
 * Driver-only (client vehicle): 0.65× base.
 * Add-ons: per-hour EUR from `lite_booking_add_ons` table (sum).
 * Peak-hour multiplier (17:00–20:00 local): 1.2×.
 * EUR → AED: fixed conversion (350 / 86 ≈ 4.07).
 *
 * EUR is source of truth; AED is display only.
 *
 * Founder 2026-08-26 — every number above is now OPS-EDITABLE via the
 * `service_pricing` table ("prices for 1x CPO, vehicle, female, price per
 * hour… everywhere the price applicable"). The compiled values below stay as
 * the FAIL-OPEN defaults: an unreachable table charges exactly what the app
 * charged before this change — never zero, never a surprise. `config()` is
 * read at CHARGE TIME (60 s cache), so an edit applies to the next quote the
 * way the M1A subscription prices already do.
 */

export interface AddOnPricing {
  id: string;
  label: string;
  price_eur_per_hour: number;
}

export interface ServicePricingConfig {
  /** THE ROOT (founder 2026-08-26): 1 BC = eur_per_bc EUR. Booking charges
   *  divide EUR totals by this; at the shipped 1.0 the numbers are
   *  byte-identical to the historic 1:1 behaviour. The WALLET top-up peg
   *  (1 fiat = 1 BC, audit F-01/F-02) is deliberately NOT driven by this
   *  key — changing what a top-up buys is its own decision. */
  eur_per_bc: number;
  transfer_base_rate_bc: number;
  transfer_extra_unit_factor: number;
  transfer_driver_only_factor: number;
  peak_multiplier: number;
  base_rate_aed: number;
  exec_cpo_rate_bc: number;
  exec_vehicle_rate_bc: number;
  exec_driver_only_rate_bc: number;
  addon_female_cpo_bc: number;
  addon_recon_bc: number;
  addon_medical_bc: number;
  addon_comms_bc: number;
  /**
   * Executive Protection minimum booking LEAD TIME, in hours — NOT a price.
   *
   * EP is always scheduled: the client picks when protection starts, and the
   * earliest allowed start is `server now + this`. It lives in this table for
   * the machinery (ops-guarded PATCH, bounds, from->to audit, 60 s cache,
   * fail-open), not because it is money — `calculate()` never reads it and lead
   * time never moves a quote.
   *
   * GLOBAL by design (founder 2026-08-31). See the migration for why neither a
   * region nor a provider scope is safely resolvable at booking time.
   */
  exec_min_lead_hours: number;
  /**
   * Minimum booking lead for the other two services (hours), 2026-09-01.
   *
   * Secure Transfer is the book-now service and has never had a lead, so its
   * seed is the smallest floor the dispatch rail can honour rather than a real
   * wait. Close Protection follows the EP rule.
   *
   * No longer GLOBAL-by-necessity: a booking's region is now DERIVED from its
   * pickup coordinates (`regionFromPoint`), so the 2026-08-31 objection — that a
   * client could shrink their own lead by naming a cheaper region — no longer
   * applies. A client cannot name a bounding box.
   */
  transfer_min_lead_hours: number;
  close_min_lead_hours: number;
  /**
   * OP-10 — the two dispatch fee percentages, previously env-only
   * (DISPATCH_PLATFORM_FEE_PCT / DISPATCH_CANCEL_FEE_PCT; the config comment
   * named the ops-console control as "the pending follow-up"). Percent, not
   * currency. The env value is the BASE the board overrides, so an environment
   * that never touches the board keeps its env-configured fee; `calculate()`
   * never reads either — they are consumed at escrow release / cancel.
   */
  platform_fee_pct: number;
  cancel_fee_pct: number;
  /**
   * 2026-09-04 — hourly-service DURATION (Secure Transfer and every other
   * per-hour service; Executive Protection keeps its own fixed-block rule).
   * Hours, not currency. The booking engine used to compile a 4 that the app
   * could not change; these are the pre-filled default and the bookable range,
   * ops-editable on the same board as every other booking number and read
   * through `resolveDurationRule()` at every quote and create. Seeded to the
   * range the DTO already enforced (1..24, default 4) so shipping them changes
   * no behaviour on its own.
   */
  hourly_default_hours: number;
  hourly_min_hours: number;
  hourly_max_hours: number;
  /**
   * B-877 (founder 2026-09-14, "confirm we can set the 4 hours per region" —
   * "Yes") — the hours a SECURE TRANSFER is billed as. Hours, not currency,
   * and PER REGION like every other key on this board.
   *
   * A transfer is a point-to-point job: the founder saw a SERVICE DURATION
   * stepper on a ten-minute transfer and said the card "is not relative". So
   * from 1.0.316 the app has NO duration control for transfers — the block is
   * the whole rule, and it is what `calculate()` multiplies the rate by and
   * what the booking STORES (hourly check-ins, the job-portal cards and the
   * mission sweep's `pickup_time + duration_hours` window all keep working on
   * a stored block). The hourly keys above are untouched and still drive every
   * per-hour service; Executive Protection keeps its own fixed 3-hour grid.
   *
   * Seeded 4 — exactly what every shipped app's stepper defaulted to — so the
   * key changes no price on its own.
   */
  transfer_block_hours: number;
}

/** Hard ceilings for the hourly-duration keys; mirrored in the ops BOUNDS. */
export const HOURLY_DURATION_HOURS_MAX = 24;

/**
 * OP-10 / B-807 — the compiled defaults with the env-configured fee percentages
 * applied as the BASE for the two fee keys. ONE function for both readers: the
 * settlement path (`PricingService.config`) and the ops board listing
 * (`OpsServicePricingController.list`). Before B-807 the board fell back to the
 * compiled 15 while settlement fell back to `DISPATCH_PLATFORM_FEE_PCT`, so on an
 * environment with the env set and no board row the console showed a fee the
 * release never applied.
 */
export function envFeeBase(appConfig?: {get<T>(key: string): T | undefined} | null): ServicePricingConfig {
  const cfg = {...DEFAULT_SERVICE_PRICING};
  const envPlatform = appConfig?.get<number>('dispatch.platformFeePct');
  const envCancel = appConfig?.get<number>('dispatch.cancelFeePct');
  if (typeof envPlatform === 'number' && Number.isFinite(envPlatform) && envPlatform >= 0) {cfg.platform_fee_pct = envPlatform;}
  if (typeof envCancel === 'number' && Number.isFinite(envCancel) && envCancel >= 0) {cfg.cancel_fee_pct = envCancel;}
  return cfg;
}

/**
 * The duration rule a booking is validated against. `fixedGrid` is set for
 * Executive Protection (3..24 in 3-hour blocks — unchanged, never ops-editable);
 * every other service gets the ops-configurable hourly range.
 */
export interface DurationRule {
  default: number;
  min: number;
  max: number;
  /** Allowed values when the service books in fixed blocks; undefined = any
   *  integer in [min, max]. */
  fixedGrid?: readonly number[];
}

export const EXEC_DURATION_GRID: readonly number[] = [3, 6, 9, 12, 15, 18, 21, 24];

/**
 * B-877 — is `service` billed as a fixed per-region BLOCK rather than an hourly
 * length the client picks?
 *
 * An ABSENT / blank service counts. That is not a guess: `PricingService.calculate`
 * branches ONLY on `'executive_protection'` and its default arm is the transfer
 * formula, so a booking that never named a service has always been priced as a
 * Secure Transfer. Deciding it here keeps the quoted `duration_rule`, the priced
 * hours and the stored hours from ever disagreeing for the same request.
 */
export function isTransferBlockService(service: string | null | undefined): boolean {
  const s = (service ?? '').trim();
  return s === '' || s === 'secure_transfer';
}

/**
 * The hours a Secure Transfer is billed as, from the (already region-resolved)
 * config.
 *
 * Same re-check-at-use discipline as `resolveDurationRule`, and for the same
 * reason: the value survives a 60 s cache, a fail-open merge, a per-region
 * overlay and hand-edited rows. A fractional, zero, negative or out-of-ceiling
 * block would either make every transfer unbookable or bill a length nobody
 * agreed to, so anything that is not a whole 1..HOURLY_DURATION_HOURS_MAX
 * collapses to the compiled 4.
 */
export function resolveTransferBlockHours(cfg: ServicePricingConfig): number {
  const raw = (cfg ?? DEFAULT_SERVICE_PRICING).transfer_block_hours;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= HOURLY_DURATION_HOURS_MAX
    ? n
    : DEFAULT_SERVICE_PRICING.transfer_block_hours;
}

/**
 * Resolve the duration rule for `service` from the (already region-resolved)
 * config, with the same re-check-at-use discipline as the lead-time helpers:
 * the values survive a 60 s cache, a fail-open merge and a per-region overlay,
 * and a bad row (min above max, a non-integer, a zero) must never make a
 * service unbookable or silently bookable for a length nobody agreed to.
 * Anything malformed collapses to the compiled defaults.
 */
export function resolveDurationRule(service: string | null | undefined, cfg: ServicePricingConfig): DurationRule {
  if ((service ?? '').trim() === 'executive_protection') {
    return {default: EXEC_DURATION_GRID[0], min: EXEC_DURATION_GRID[0], max: EXEC_DURATION_GRID[EXEC_DURATION_GRID.length - 1], fixedGrid: EXEC_DURATION_GRID};
  }
  // B-877 — a Secure Transfer has ONE legal length: the region's block. The rule
  // is reported collapsed (default == min == max) rather than omitted so the
  // estimate reply stays internally consistent with the hours it quotes. NOTE: a
  // pre-1.0.316 app does NOT read duration_rule (its stepper bounds come from the
  // hourly_* board mirror), so its label may still show the stepper's hours while
  // the charge is the block. The server never REFUSES an old app's value; see
  // resolveDurationOrThrow.
  if (isTransferBlockService(service)) {
    const block = resolveTransferBlockHours(cfg);
    return {default: block, min: block, max: block};
  }
  const int = (raw: unknown): number | null => {
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= HOURLY_DURATION_HOURS_MAX ? n : null;
  };
  let min = int(cfg.hourly_min_hours) ?? DEFAULT_SERVICE_PRICING.hourly_min_hours;
  let max = int(cfg.hourly_max_hours) ?? DEFAULT_SERVICE_PRICING.hourly_max_hours;
  if (min > max) {
    min = DEFAULT_SERVICE_PRICING.hourly_min_hours;
    max = DEFAULT_SERVICE_PRICING.hourly_max_hours;
  }
  let def = int(cfg.hourly_default_hours) ?? DEFAULT_SERVICE_PRICING.hourly_default_hours;
  if (def < min || def > max) {def = Math.min(Math.max(DEFAULT_SERVICE_PRICING.hourly_default_hours, min), max);}
  return {default: def, min, max};
}

/**
 * The duration a booking is PRICED and STORED with. The client's value is
 * honoured only when it is a legal member of the rule; an absent value takes
 * the rule's default; anything else is rejected — the server never silently
 * reprices a length the client did not see (same reject-never-reprice stance
 * as the executive seat cap).
 */
export function resolveDurationHours(
  requested: number | null | undefined,
  rule: DurationRule,
): {ok: true; hours: number} | {ok: false; reason: 'not_integer' | 'out_of_range' | 'off_grid'} {
  if (requested === null || requested === undefined) {return {ok: true, hours: rule.default};}
  if (!Number.isInteger(requested)) {return {ok: false, reason: 'not_integer'};}
  if (rule.fixedGrid) {
    return rule.fixedGrid.includes(requested) ? {ok: true, hours: requested} : {ok: false, reason: 'off_grid'};
  }
  if (requested < rule.min || requested > rule.max) {return {ok: false, reason: 'out_of_range'};}
  return {ok: true, hours: requested};
}

/**
 * Coerce an ops-configured EP lead time into something bookable.
 *
 * The table's own CHECK already rejects <= 0 and >= 100000, and the ops PATCH
 * enforces 1..168 - but this value also arrives from a 60 s cache, a fail-open
 * default merge and (historically) hand-edited rows, so it is re-checked at the
 * point of USE. A bad configuration must never make every EP booking silently
 * unbookable (or, worse, silently bookable with no lead at all): anything
 * non-finite, non-positive or past the ceiling falls back to the compiled
 * default rather than propagating.
 */
export function resolveExecLeadHours(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > EXEC_LEAD_HOURS_MAX) {
    return DEFAULT_SERVICE_PRICING.exec_min_lead_hours;
  }
  return n;
}

/** Mirrors the ops BOUNDS ceiling; a week of lead makes EP unbookable. */
/**
 * The sentinel region every price falls back to. Not a real region code — the
 * ops controller refuses it as one — so a global row and a region row can share
 * the (key, region_code) primary key.
 */
export const GLOBAL_REGION = 'GLOBAL';

export const EXEC_LEAD_HOURS_MAX = 168;

/** Which config key carries each bookable service's minimum lead. */
const LEAD_KEY_BY_SERVICE: Record<string, keyof ServicePricingConfig> = {
  executive_protection: 'exec_min_lead_hours',
  close_protection:     'close_min_lead_hours',
  secure_transfer:      'transfer_min_lead_hours',
};

/**
 * Minimum lead time in hours for `service`, from the (already region-resolved)
 * config.
 *
 * Same re-check-at-use discipline as `resolveExecLeadHours` and for the same
 * reason: the value survives a 60 s cache, a fail-open merge and a per-region
 * overlay, and a bad one must never make a service silently unbookable OR
 * silently bookable with no lead at all. An UNKNOWN service gets 0 — it has no
 * configured lead, and inventing one would block a booking flow that never had
 * a wait.
 */
export function resolveLeadHours(service: string | null | undefined, cfg: ServicePricingConfig): number {
  const key = LEAD_KEY_BY_SERVICE[(service ?? '').trim()];
  if (!key) {return 0;}
  const n = Number(cfg[key]);
  if (!Number.isFinite(n) || n <= 0 || n > EXEC_LEAD_HOURS_MAX) {
    return Number(DEFAULT_SERVICE_PRICING[key]);
  }
  return n;
}

/** The shipped numbers — seeds of service_pricing and the fail-open floor. */
export const DEFAULT_SERVICE_PRICING: ServicePricingConfig = {
  eur_per_bc: 1.0,
  transfer_base_rate_bc: 86,
  transfer_extra_unit_factor: 0.25,
  transfer_driver_only_factor: 0.65,
  peak_multiplier: 1.2,
  base_rate_aed: 350,
  exec_cpo_rate_bc: 86,
  exec_vehicle_rate_bc: 30,
  exec_driver_only_rate_bc: 20,
  addon_female_cpo_bc: 120,
  addon_recon_bc: 100,
  addon_medical_bc: 90,
  addon_comms_bc: 75,
  exec_min_lead_hours: 3,
  transfer_min_lead_hours: 0.25,
  close_min_lead_hours: 3,
  // Same numbers as the env defaults in configuration.ts (`dispatch.*FeePct`).
  platform_fee_pct: 15,
  cancel_fee_pct: 25,
  // The range the create DTO already enforced (@Min(1) @Max(24)) and the 4 the
  // engine used to hard-code — byte-identical behaviour until ops edits them.
  hourly_default_hours: 4,
  hourly_min_hours: 1,
  hourly_max_hours: 24,
  // B-877 — the block a Secure Transfer is billed as. 4 is the duration every
  // shipped app's stepper pre-selected and the value the engine already stored
  // for a transfer that did not choose, so the key ships behaviour-neutral.
  transfer_block_hours: 4,
};

export interface PricingInput {
  cpoCount: number;
  vehicleCount: number;
  driverOnly: boolean;
  durationHours: number;
  pickupTime: Date;
  addOns: AddOnPricing[];
  /** LM-M2 — region the pickup happens in; drives the LOCAL peak-hour window.
   *  Optional so legacy callers keep compiling (missing region = UTC, the old
   *  behaviour). */
  regionCode?: string;
  /** Executive Protection — 'executive_protection' switches to the per-unit fixed-block formula. */
  service?: string;
}

export interface PricingBreakdownLine {
  label: string;
  amount_eur: number;
}

export interface PricingResult {
  /** What escrow actually holds — EUR total / eur_per_bc, rounded. */
  total_bc: number;
  rate_eur_per_hour: number;
  rate_aed_per_hour: number;
  total_eur: number;
  total_aed: number;
  breakdown: PricingBreakdownLine[];
}

const BASE_RATE_EUR = DEFAULT_SERVICE_PRICING.transfer_base_rate_bc;

// ─── Executive Protection (service 'executive_protection') — per-unit fixed-block pricing ───────────────
// rate/hr = cpo_count × CPO_RATE + vehicle_count × VEHICLE_RATE
//           (+ DRIVER_ONLY_RATE when a Bravo driver runs the client's vehicle)
//           + Σ add-ons; total = rate × duration. FLAT — no peak multiplier:
// the quote the client consents to on the review screen is exactly what
// escrow holds (mock: 1 CPO · 3 h = 86 × 3 = 258 BC even at 17:05).
export const EXEC_CPO_RATE_EUR = DEFAULT_SERVICE_PRICING.exec_cpo_rate_bc;
/** Vehicle + dedicated driver. ≈ the vehicle share of the Lite base
 *  (86 − 0.65×86 ≈ 30) so the two products price consistently. */
export const EXEC_VEHICLE_RATE_EUR = DEFAULT_SERVICE_PRICING.exec_vehicle_rate_bc;
/** Bravo driver operating the client's own vehicle (driver-only toggle). */
export const EXEC_DRIVER_ONLY_RATE_EUR = DEFAULT_SERVICE_PRICING.exec_driver_only_rate_bc;

/** Executive add-on IDs → their service_pricing key + fixed label. The label
 *  set is the product catalogue; only the NUMBERS are ops-editable. */
const EXEC_ADDON_DEFS: ReadonlyArray<{id: string; label: string; cfgKey: keyof ServicePricingConfig}> = [
  {id: 'female_cpo', label: 'Female CPO Team',               cfgKey: 'addon_female_cpo_bc'},
  {id: 'recon',      label: 'Advance Assessment Team',       cfgKey: 'addon_recon_bc'},
  {id: 'medical',    label: 'Medical Support',               cfgKey: 'addon_medical_bc'},
  {id: 'comms',      label: 'Secure Communications Support', cfgKey: 'addon_comms_bc'},
];

/** executive add-on catalogue — display == charge (client mirrors these). */
export const EXEC_ADDON_PRICING: ReadonlyArray<AddOnPricing> = EXEC_ADDON_DEFS.map(d => ({
  id: d.id, label: d.label, price_eur_per_hour: DEFAULT_SERVICE_PRICING[d.cfgKey],
}));

/** Resolve executive add-on ids against the catalogue at the LIVE prices.
 *  Unknown id = null so the caller can 400 instead of silently underpricing. */
export function resolveExecAddOns(
  ids: string[],
  cfg: ServicePricingConfig = DEFAULT_SERVICE_PRICING,
): AddOnPricing[] | null {
  const out: AddOnPricing[] = [];
  for (const id of ids) {
    const found = EXEC_ADDON_DEFS.find(a => a.id === id);
    if (!found) {return null;}
    out.push({id: found.id, label: found.label, price_eur_per_hour: cfg[found.cfgKey]});
  }
  return out;
}

const CONFIG_TTL_MS = 60_000;

@Injectable()
export class PricingService {
  private readonly log = new Logger(PricingService.name);
  private readonly cfgCache = new Map<string, {at: number; cfg: ServicePricingConfig}>();
  // OP-02 — cluster-wide invalidation. The ops write bumps `cfgver:pricing` in
  // shared Redis; every pod compares its cache against it (2 s mirror) and
  // drops the whole map when it moved. The 60 s TTL stays as the no-Redis
  // fallback. `cacheVersion` is the version the CURRENT map was built under.
  private readonly version = new ConfigVersionMirror('pricing');
  private cacheVersion: number | null = null;

  // @Optional: the calculator itself is pure, and a pile of specs construct it
  // bare (`new PricingService()`). No db → compiled defaults, same numbers as
  // before this change. Redis/config are optional for the same reason; both
  // modules are @Global so DI fills them in production.
  constructor(
    @Optional() private readonly db?: DatabaseService,
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly appConfig?: ConfigService,
  ) {}


  /**
   * The live pricing config — service_pricing overlaid on the compiled
   * defaults, cached 60 s, FAIL-OPEN on any error. Read at charge time by
   * booking.service so an ops edit prices the next quote.
   */
  /**
   * The live pricing config for `regionCode`, cached 60 s per region,
   * FAIL-OPEN on any error.
   *
   * THREE LAYERS, most specific last:
   *
   *     compiled DEFAULT_SERVICE_PRICING  ->  'GLOBAL' rows  ->  this region's rows
   *
   * A region therefore overrides only the keys ops actually set for it: nobody
   * re-enters sixteen numbers to make one region's CPO rate different, and a
   * later change to a global rate still flows into every region that has not
   * deliberately diverged on that key.
   *
   * `regionCode` MUST be server-derived (`regionFromPoint` on the booking's
   * pickup coordinates), never the client's `dto.region` — that field is
   * attacker-controlled, and pricing on it would let anyone name the cheapest
   * region and pay its rate. Omitting it resolves GLOBAL, which is the safe
   * direction: a booking whose coordinates match no region can never be cheaper
   * than the global price, only equal to it.
   */
  async config(regionCode?: string | null): Promise<ServicePricingConfig> {
    const region = (regionCode ?? '').trim().toUpperCase() || GLOBAL_REGION;
    const now = Date.now();
    // OP-02 — a moved cluster version invalidates every region's entry at once.
    const ver = await this.version.current(this.redis, now);
    if (ver !== null && ver !== this.cacheVersion) {
      this.cfgCache.clear();
      this.cacheVersion = ver;
    }
    const hit = this.cfgCache.get(region);
    if (hit && now - hit.at < CONFIG_TTL_MS) {return hit.cfg;}

    // OP-10 — the env-configured fee percentages are the BASE for the two fee
    // keys; a board row (below) overrides them. Keeps every existing deployment's
    // fee exactly where its env put it until ops deliberately moves it.
    const cfg = envFeeBase(this.appConfig);
    if (this.db) {
      try {
        // Both layers in ONE query, ordered so the region's rows are applied
        // AFTER the global ones. Doing it in two round trips would let an ops
        // edit land between them and produce a config that never existed.
        const rows = await this.db.q<{key: string; value: string; region_code: string}>(
          `SELECT key, value, region_code
             FROM service_pricing
            WHERE region_code = $1 OR region_code = $2
            ORDER BY CASE WHEN region_code = $1 THEN 0 ELSE 1 END`,
          [GLOBAL_REGION, region],
        );
        for (const r of rows) {
          const v = Number(r.value);
          if (r.key in cfg && Number.isFinite(v) && v > 0) {
            (cfg as unknown as Record<string, number>)[r.key] = v;
          }
        }
      } catch (e) {
        this.log.warn(`service_pricing read failed, using defaults: ${e instanceof Error ? e.message : e}`);
      }
    }
    // Bounded: one entry per region the service has actually priced, and regions
    // are ops-created rows, not user input, so this cannot be grown by traffic.
    this.cfgCache.set(region, {at: now, cfg});
    return cfg;
  }

  calculate(input: PricingInput, cfg: ServicePricingConfig = DEFAULT_SERVICE_PRICING): PricingResult {
    if (input.service === 'executive_protection') {return this.calculateExecutive(input, cfg);}
    const eurToAed = cfg.base_rate_aed / cfg.transfer_base_rate_bc;
    const breakdown: PricingBreakdownLine[] = [];
    let rate = cfg.transfer_base_rate_bc;
    breakdown.push({label: 'Base rate (1 CPO · 1 Vehicle · 1 Driver)', amount_eur: cfg.transfer_base_rate_bc});

    const extraCpos = Math.max(0, input.cpoCount - 1);
    if (extraCpos > 0) {
      const add = extraCpos * cfg.transfer_base_rate_bc * cfg.transfer_extra_unit_factor;
      rate += add;
      breakdown.push({label: `+${extraCpos} CPO`, amount_eur: +add.toFixed(2)});
    }

    const extraVehicles = Math.max(0, input.vehicleCount - 1);
    if (extraVehicles > 0) {
      const add = extraVehicles * cfg.transfer_base_rate_bc * cfg.transfer_extra_unit_factor;
      rate += add;
      breakdown.push({label: `+${extraVehicles} Vehicle`, amount_eur: +add.toFixed(2)});
    }

    if (input.driverOnly) {
      const before = rate;
      rate *= cfg.transfer_driver_only_factor;
      breakdown.push({
        label: `Driver-only discount (−${Math.round((1 - cfg.transfer_driver_only_factor) * 100)}%)`,
        amount_eur: +(rate - before).toFixed(2),
      });
    }

    for (const a of input.addOns) {
      rate += a.price_eur_per_hour;
      breakdown.push({label: a.label, amount_eur: a.price_eur_per_hour});
    }

    // Peak surcharge — LM-M2: 17:00–20:00 in the REGION's local wall clock (the
    // doc always said "local"; the old getUTCHours() fired the surcharge at the
    // wrong time in every non-UTC region, e.g. 21:00–24:00 Dubai time).
    const hour = (input.pickupTime.getUTCHours() + regionUtcOffsetHours(input.regionCode) + 24) % 24;
    let peakMultiplier = 1;
    if (hour >= 17 && hour < 20) {
      peakMultiplier = cfg.peak_multiplier;
      const surcharge = rate * (cfg.peak_multiplier - 1);
      breakdown.push({label: 'Peak surcharge (17–20)', amount_eur: +surcharge.toFixed(2)});
    }

    const rateEur = +(rate * peakMultiplier).toFixed(2);
    const durationHours = Math.max(1, input.durationHours);
    const totalEur = +(rateEur * durationHours).toFixed(2);

    return {
      total_bc: Math.round(totalEur / cfg.eur_per_bc),
      rate_eur_per_hour: rateEur,
      rate_aed_per_hour: +(rateEur * eurToAed).toFixed(2),
      total_eur: totalEur,
      total_aed: +(totalEur * eurToAed).toFixed(2),
      breakdown,
    };
  }

  /** Executive Protection — per-unit hourly pricing over a fixed 3–24 h block. */
  private calculateExecutive(input: PricingInput, cfg: ServicePricingConfig): PricingResult {
    const eurToAed = cfg.base_rate_aed / cfg.transfer_base_rate_bc;
    const breakdown: PricingBreakdownLine[] = [];

    const cpoAmt = input.cpoCount * cfg.exec_cpo_rate_bc;
    let rate = cpoAmt;
    breakdown.push({
      label: `${input.cpoCount} × Close Protection Officer`,
      amount_eur: +cpoAmt.toFixed(2),
    });

    // Driver-only means the client's own vehicle — never price Bravo vehicles,
    // even if a raw API caller sends both (create() normalizes; estimate()
    // and the client mirror rely on this being enforced HERE too).
    const vehicles = input.driverOnly ? 0 : input.vehicleCount;
    if (vehicles > 0) {
      const vehAmt = vehicles * cfg.exec_vehicle_rate_bc;
      rate += vehAmt;
      breakdown.push({
        label: `${vehicles} × Vehicle & Driver`,
        amount_eur: +vehAmt.toFixed(2),
      });
    }

    if (input.driverOnly) {
      rate += cfg.exec_driver_only_rate_bc;
      breakdown.push({
        label: 'Bravo driver (client vehicle)',
        amount_eur: cfg.exec_driver_only_rate_bc,
      });
    }

    for (const a of input.addOns) {
      rate += a.price_eur_per_hour;
      breakdown.push({label: a.label, amount_eur: a.price_eur_per_hour});
    }

    // Fixed-block product — flat hourly rate, deliberately NO peak multiplier.
    const rateEur = +rate.toFixed(2);
    const durationHours = Math.max(1, input.durationHours);
    const totalEur = +(rateEur * durationHours).toFixed(2);

    return {
      total_bc: Math.round(totalEur / cfg.eur_per_bc),
      rate_eur_per_hour: rateEur,
      rate_aed_per_hour: +(rateEur * eurToAed).toFixed(2),
      total_eur: totalEur,
      total_aed: +(totalEur * eurToAed).toFixed(2),
      breakdown,
    };
  }
}

/**
 * Referral / discount campaign (2026-09-05) — take a EUR discount off a
 * computed quote. The ONE place the arithmetic lives, shared by estimate()
 * and createBooking() so the preview and the charge agree by construction.
 *
 * The breakdown lines are left EXACTLY as computed: the ops exec-breakdown
 * mapper matches persisted lines POSITIONALLY against the booking's unit
 * slots, so an appended "discount" line would make it fall back to a
 * recompute. The discount travels on its own booking columns instead.
 * `total_bc` is re-derived from the discounted EUR, never subtracted in BC,
 * so rounding matches what escrow will actually hold.
 */
export function applyDiscount(
  result: PricingResult, discountEur: number, cfg: ServicePricingConfig = DEFAULT_SERVICE_PRICING,
): PricingResult {
  const off = Math.min(Math.max(0, discountEur), result.total_eur);
  if (!(off > 0)) return result;
  const eurToAed = cfg.base_rate_aed / cfg.transfer_base_rate_bc;
  const totalEur = +(result.total_eur - off).toFixed(2);
  return {
    ...result,
    total_eur: totalEur,
    total_aed: +(totalEur * eurToAed).toFixed(2),
    total_bc: Math.round(totalEur / cfg.eur_per_bc),
  };
}

// Compiled constant kept for legacy importers; identical to the default config.
void BASE_RATE_EUR;
