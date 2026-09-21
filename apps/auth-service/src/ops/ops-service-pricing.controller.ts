import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, Optional, Param, Patch, Query, Req, UseGuards,
} from '@nestjs/common';
import type {Request} from 'express';
import {IsIn, IsNumber, IsOptional, IsString, Matches, Min} from 'class-validator';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {AdminGuard, RequireRoles, type AdminContext} from './admin.guard';
import {DatabaseService} from '../database/database.service';
import {OpsAuditService} from './ops-audit.service';
import {ConfigService} from '@nestjs/config';
import {
  DEFAULT_SERVICE_PRICING, GLOBAL_REGION, envFeeBase, type ServicePricingConfig,
} from '../booking/pricing.service';
import {RegionsService} from '../common/regions.service';
import {supportedRegionCodes} from '../common/regions';
import {RedisService} from '../redis/redis.service';
import {bumpConfigVersion} from '../common/services/config-version';
import {Throttle} from '@nestjs/throttler';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {OPS_THROTTLE} from './ops-throttle';

type OpsReq = Request & {admin: AdminContext};

const KEYS = Object.keys(DEFAULT_SERVICE_PRICING) as Array<keyof ServicePricingConfig>;

/**
 * Per-key sanity bounds — a fat-fingered extra zero on a live rate is a
 * production incident, and a factor above 1 silently turns a discount into a
 * surcharge. The DB CHECK (0 < value < 100000) is the backstop; these are the
 * business bounds.
 */
const BOUNDS: Record<keyof ServicePricingConfig, {min: number; max: number}> = {
  eur_per_bc:                  {min: 0.01, max: 100},
  transfer_base_rate_bc:       {min: 1,    max: 10_000},
  transfer_extra_unit_factor:  {min: 0.01, max: 1},
  transfer_driver_only_factor: {min: 0.05, max: 1},
  peak_multiplier:             {min: 1,    max: 3},
  base_rate_aed:               {min: 1,    max: 50_000},
  exec_cpo_rate_bc:            {min: 1,    max: 10_000},
  exec_vehicle_rate_bc:        {min: 1,    max: 10_000},
  exec_driver_only_rate_bc:    {min: 1,    max: 10_000},
  addon_female_cpo_bc:         {min: 1,    max: 10_000},
  addon_recon_bc:              {min: 1,    max: 10_000},
  addon_medical_bc:            {min: 1,    max: 10_000},
  addon_comms_bc:              {min: 1,    max: 10_000},
  // Hours, not currency. Floor 1: a zero/negative lead is already blocked by the
  // column CHECK, but "book protection starting right now" is not a state the
  // dispatch rail can honour either. Ceiling 168 (one week) is a fat-finger
  // guard - a larger value would make every EP booking unbookable.
  exec_min_lead_hours:         {min: 1,    max: 168},
  // Secure Transfer is the BOOK-NOW service: its floor is the smallest lead the
  // dispatch rail can honour (15 min), not a wait. Same 1-week fat-finger
  // ceiling; a larger value would make the service unbookable.
  transfer_min_lead_hours:     {min: 0.25, max: 168},
  close_min_lead_hours:        {min: 0.25, max: 168},
  // OP-10 — percentages. The DB CHECK (0 < value) means a literal 0% cannot be
  // stored on the board; clear the row to fall back to the env base instead.
  platform_fee_pct:            {min: 0.01, max: 50},
  cancel_fee_pct:              {min: 0.01, max: 100},
  // B-795 (2026-09-04) — hourly-service duration, in whole hours. The engine
  // re-checks min <= default <= max at the point of use and falls back to the
  // compiled 4 / 1 / 24 on a contradictory board, so a fat-fingered row degrades
  // to the shipped behaviour rather than making the service unbookable. Keep
  // the minimum <= 4 while apps without the duration control are installed.
  hourly_default_hours:        {min: 1,    max: 24},
  hourly_min_hours:            {min: 1,    max: 24},
  hourly_max_hours:            {min: 1,    max: 24},
  // B-877 (2026-09-14) — the block a Secure Transfer is BILLED as, in whole
  // hours, per region. Not a length the client picks: the app has no duration
  // control for transfers from 1.0.316, so this number IS the charge multiplier
  // (rate x block) and the stored `duration_hours` every downstream window reads.
  // Same 1..24 range as the hourly keys; the engine re-checks it at the point of
  // use (`resolveTransferBlockHours`) and falls back to the compiled 4 on a
  // fractional or out-of-range row rather than making transfers unbookable.
  transfer_block_hours:        {min: 1,    max: 24},
};

export class SetServicePriceDto {
  @IsIn(KEYS as string[]) key!: keyof ServicePricingConfig;
  @IsNumber() @Min(0.000001) value!: number;
  /**
   * Which region this price applies to. Omitted = GLOBAL, the value every region
   * inherits unless it has deliberately diverged on this key.
   *
   * Validated against the LIVE region list, so a typo cannot create a price row
   * for a region that does not exist — that row would be invisible, un-editable
   * from the board, and would start applying the day someone created a region
   * with that code.
   */
  @IsOptional() @IsString() @Matches(/^[A-Z]{2,8}$/, {message: 'region must be an uppercase region code'})
  region_code?: string;
}

/**
 * Founder 2026-08-26 — SERVICE pricing administration ("secure transfers,
 * executive protection… 1x CPO, vehicle, female, price per hour — everywhere
 * the price applicable", plus the eur_per_bc root). Charged at charge time
 * via PricingService.config() (60 s cache), so an edit prices the next quote;
 * already-created bookings keep their stored totals.
 */
@Controller('ops/service-pricing')
// Ops console rate limiting (booking-lane critic 2026-09-04): bind a
// ThrottlerGuard subclass LAST (after JwtAuthGuard, so req.user is set when
// getTracker runs) so this surface is limited per USER. That binding is also
// what makes GlobalHttpThrottlerGuard.shouldSkip skip these routes — without it
// the whole console shares ONE per-IP bucket per office NAT.
@Throttle(OPS_THROTTLE)
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard, UserThrottlerGuard)
@RequireRoles('SUPERVISOR', 'ADMIN')
export class OpsServicePricingController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: OpsAuditService,
    private readonly regions: RegionsService,
    // OP-02 — @Optional so the existing specs' 3-arg construction keeps working.
    @Optional() private readonly redis?: RedisService,
    // B-807 — the env fee base, so the board's fallback for the two fee keys is
    // the SAME number settlement falls back to (`envFeeBase`, shared).
    @Optional() private readonly config?: ConfigService,
  ) {}

  /** A region code the board may write, or GLOBAL. Throws otherwise. */
  private async assertRegion(raw: string | undefined): Promise<string> {
    const code = (raw ?? '').trim().toUpperCase();
    if (!code || code === GLOBAL_REGION) {return GLOBAL_REGION;}
    // Live list, not the compiled one — a region added in ops five minutes ago
    // must be priceable without waiting for a deploy.
    await this.regions.ensureFresh();
    if (!supportedRegionCodes().includes(code)) {
      throw new BadRequestException(`unknown_region:${code}`);
    }
    return code;
  }

  /**
   * The board for one region (default GLOBAL).
   *
   * Each key reports the value that would actually be CHARGED there — the
   * region's own row if it has one, otherwise the global row, otherwise the
   * compiled default — plus `inherited`, so the console can show at a glance
   * which of a region's numbers are its own and which are following global.
   * Without that flag an editor cannot tell a deliberate match from an
   * un-set key, and "changing" an inherited value looks like a no-op.
   */
  @Get()
  async list(@Query('region') regionRaw?: string) {
    const region = await this.assertRegion(regionRaw);
    const rows = await this.db.q<{key: string; value: string; region_code: string; updated_at: string}>(
      `SELECT key, value, region_code, updated_at
         FROM service_pricing
        WHERE region_code = $1 OR region_code = $2
        ORDER BY key`,
      [GLOBAL_REGION, region],
    );
    const globals = new Map(rows.filter(r => r.region_code === GLOBAL_REGION).map(r => [r.key, r]));
    const locals  = new Map(rows.filter(r => r.region_code === region).map(r => [r.key, r]));

    // Emit EVERY key, table-backed or defaulted, so the console renders the
    // full board even before the migration ran anywhere. B-807: the no-row
    // fallback is the env base (what settlement actually applies), not the
    // compiled default — `default_value` stays the compiled number.
    const base = envFeeBase(this.config);
    return {
      region,
      pricing: KEYS.map(k => {
        const own = region === GLOBAL_REGION ? undefined : locals.get(k);
        const fallback = globals.get(k);
        const source = own ?? fallback;
        return {
          key: k,
          value: source ? Number(source.value) : base[k],
          default_value: DEFAULT_SERVICE_PRICING[k],
          global_value: fallback ? Number(fallback.value) : base[k],
          inherited: !own,
          updated_at: source?.updated_at ?? null,
          min: BOUNDS[k].min,
          max: BOUNDS[k].max,
        };
      }),
    };
  }

  /**
   * Drop a region's own value for one key so it follows GLOBAL again.
   *
   * Without this there is no way back: setting a region's rate to today's global
   * number looks the same on screen but PINS it, and the region silently stops
   * tracking later global changes. Refused for GLOBAL itself — that row is the
   * fallback, and deleting it would drop the whole region to the compiled
   * default with nothing on the board to explain why.
   */
  @Delete(':key')
  @HttpCode(200)
  async clear(@Param('key') key: string, @Query('region') regionRaw: string, @Req() req: OpsReq) {
    if (!(KEYS as string[]).includes(key)) {throw new BadRequestException('unknown_key');}
    const region = await this.assertRegion(regionRaw);
    if (region === GLOBAL_REGION) {throw new BadRequestException('cannot_clear_global');}
    const gone = await this.db.qOne<{value: string}>(
      `DELETE FROM service_pricing WHERE key = $1 AND region_code = $2 RETURNING value`,
      [key, region],
    );
    if (gone) {
      await this.audit.recordAdmin(req.admin, 'pricing.service.clear', 'system', `${region}:${key}`, {
        from: Number(gone.value), to: 'inherit',
      });
      // OP-02 — every pod's PricingService drops its board within 2 s.
      await bumpConfigVersion(this.redis, 'pricing');
    }
    return {key, region, inherited: true};
  }

  @Patch()
  @HttpCode(200)
  async set(@Body() dto: SetServicePriceDto, @Req() req: OpsReq) {
    const b = BOUNDS[dto.key];
    if (!b || dto.value < b.min || dto.value > b.max) {
      throw new BadRequestException(`value_out_of_bounds:${b?.min}..${b?.max}`);
    }
    // OC-03 — capture the previous value so the audit row carries from→to.
    // eur_per_bc is the platform's fiat↔BC root; a change with no trail is
    // an incident, not a setting.
    const region = await this.assertRegion(dto.region_code);
    const prev = await this.db.qOne<{value: string}>(
      `SELECT value FROM service_pricing WHERE key = $1 AND region_code = $2`,
      [dto.key, region],
    );
    // The "from" a region is moving off is whatever it was CHARGING — its own
    // row, else global, else compiled. Reporting the compiled default when the
    // region was actually inheriting a global override would make the audit
    // trail state a number nobody was ever charged.
    let fromValue: number;
    if (prev) {
      fromValue = Number(prev.value);
    } else {
      const glob = region === GLOBAL_REGION ? null : await this.db.qOne<{value: string}>(
        `SELECT value FROM service_pricing WHERE key = $1 AND region_code = $2`,
        [dto.key, GLOBAL_REGION],
      );
      fromValue = glob ? Number(glob.value) : DEFAULT_SERVICE_PRICING[dto.key];
    }
    // Upsert: the board must be editable even on an environment where the
    // seed migration has not run (the read path already defaults).
    const row = await this.db.qOne<{key: string; value: string}>(
      `INSERT INTO service_pricing (key, value, region_code, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key, region_code) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by
       RETURNING key, value`,
      [dto.key, dto.value, region, req.admin.user_id],
    );
    // Region in the audit TARGET, not only the payload: an ops trail is read by
    // scanning targets, and "eur_per_bc changed" without a region is unanswerable
    // once more than one region is priced.
    await this.audit.recordAdmin(req.admin, 'pricing.service.update', 'system', `${region}:${dto.key}`, {
      from: fromValue, to: dto.value, region,
    });
    // OP-02 — cluster-wide: the per-pod 60 s cache used to be the only thing
    // that ever noticed this write, and pods disagreed for a minute.
    await bumpConfigVersion(this.redis, 'pricing');
    return {key: row!.key, value: Number(row!.value), region};
  }
}
