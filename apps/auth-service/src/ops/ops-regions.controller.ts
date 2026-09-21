import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, Optional, Param, Patch, Post, Req, UseGuards,
} from '@nestjs/common';
import type {Request} from 'express';
import {
  IsBoolean, IsNumber, IsOptional, IsString, Length, Matches, Max, Min, ValidateIf,
} from 'class-validator';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {AdminGuard, RequireRoles, type AdminContext} from './admin.guard';
import {DatabaseService} from '../database/database.service';
import {OpsAuditService} from './ops-audit.service';
import {RegionsService} from '../common/regions.service';
import {RedisService} from '../redis/redis.service';
import {bumpConfigVersion} from '../common/services/config-version';
import {DEFAULT_REGIONS} from '../common/regions';
import {Throttle} from '@nestjs/throttler';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {OPS_THROTTLE} from './ops-throttle';

type OpsReq = Request & {admin: AdminContext};

/**
 * A bounding box is all-or-nothing on the way in, matching the table CHECK.
 * A half-supplied box is the state that would silently mis-resolve a booking's
 * pricing region, so it is rejected here with a readable message rather than
 * surfacing as a Postgres constraint name.
 */
class RegionBoxDto {
  @IsOptional() @IsNumber() @Min(-90)  @Max(90)  min_lat?: number;
  @IsOptional() @IsNumber() @Min(-90)  @Max(90)  max_lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) min_lng?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) max_lng?: number;
}

export class CreateRegionDto extends RegionBoxDto {
  // Uppercase ISO-ish. Deliberately allows more than 2 chars: a sub-national
  // region ("AE-DXB") is a plausible future without a migration.
  @IsString() @Matches(/^[A-Z]{2,8}$/, {message: 'code must be 2-8 uppercase letters'})
  code!: string;

  @IsString() @Length(1, 120) name!: string;

  @IsString() @Matches(/^[A-Z]{3}$/, {message: 'currency must be a 3-letter code'})
  currency!: string;

  @IsOptional() @IsNumber() @Min(-12) @Max(14) utc_offset_hours?: number;

  @IsOptional() @IsBoolean() launched?: boolean;
}

export class UpdateRegionDto extends RegionBoxDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsString() @Matches(/^[A-Z]{3}$/) currency?: string;
  @IsOptional() @IsNumber() @Min(-12) @Max(14) utc_offset_hours?: number;
  @IsOptional() @IsBoolean() launched?: boolean;
  /** Explicitly clear the bounding box (the region stops resolving from coordinates). */
  @IsOptional() @IsBoolean() clear_bbox?: boolean;
  @ValidateIf(o => o.clear_bbox === true && o.min_lat !== undefined)
  @IsOptional() _never?: never;
}

function readBox(dto: RegionBoxDto): {ok: true; box: number[] | null} | {ok: false; why: string} {
  const vals = [dto.min_lat, dto.max_lat, dto.min_lng, dto.max_lng];
  const given = vals.filter(v => v !== undefined && v !== null);
  if (given.length === 0) {return {ok: true, box: null};}
  if (given.length !== 4) {
    return {ok: false, why: 'bbox_incomplete: supply all of min_lat, max_lat, min_lng, max_lng, or none'};
  }
  const [minLat, maxLat, minLng, maxLng] = vals as number[];
  if (minLat >= maxLat) {return {ok: false, why: 'bbox_invalid: min_lat must be below max_lat'};}
  if (minLng >= maxLng) {return {ok: false, why: 'bbox_invalid: min_lng must be below max_lng'};}
  return {ok: true, box: [minLat, maxLat, minLng, maxLng]};
}

/**
 * Client 2026-09-01 — "we need to be able to add regions as we get service
 * providers."
 *
 * Regions were a compiled TypeScript array, so onboarding a provider in a new
 * country meant a code change and a deploy. They are now rows, edited here.
 *
 * Every write refreshes `RegionsService` immediately rather than waiting out the
 * 60 s cache, so the admin who added a region sees it take effect on their next
 * request instead of wondering whether the save worked.
 */
@Controller('ops/regions')
// Ops console rate limiting (booking-lane critic 2026-09-04): bind a
// ThrottlerGuard subclass LAST (after JwtAuthGuard, so req.user is set when
// getTracker runs) so this surface is limited per USER. That binding is also
// what makes GlobalHttpThrottlerGuard.shouldSkip skip these routes — without it
// the whole console shares ONE per-IP bucket per office NAT.
@Throttle(OPS_THROTTLE)
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard, UserThrottlerGuard)
@RequireRoles('SUPERVISOR', 'ADMIN')
export class OpsRegionsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: OpsAuditService,
    private readonly regions: RegionsService,
    // OP-05 — @Optional keeps the specs' 3-arg construction working.
    @Optional() private readonly redis?: RedisService,
  ) {}

  @Get()
  async list() {
    const rows = await this.db.q<Record<string, unknown>>(
      `SELECT code, name, currency, utc_offset_hours, launched,
              min_lat, max_lat, min_lng, max_lng, updated_at
         FROM public.regions ORDER BY code`,
    );
    // Fall back to the compiled set when the migration has not run here, so the
    // console renders a board rather than an empty screen that reads as
    // "you have no regions" — which is never true.
    if (rows.length === 0) {
      return {
        regions: DEFAULT_REGIONS.map(r => ({
          code: r.code, name: r.name, currency: r.currency,
          utc_offset_hours: r.utcOffsetHours, launched: r.launched,
          min_lat: r.bbox?.minLat ?? null, max_lat: r.bbox?.maxLat ?? null,
          min_lng: r.bbox?.minLng ?? null, max_lng: r.bbox?.maxLng ?? null,
          updated_at: null, seeded: true,
        })),
      };
    }
    return {regions: rows.map(r => ({...r, seeded: false}))};
  }

  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateRegionDto, @Req() req: OpsReq) {
    const box = readBox(dto);
    if (!box.ok) {throw new BadRequestException(box.why);}

    const existing = await this.db.qOne<{code: string}>(
      `SELECT code FROM public.regions WHERE code = $1`, [dto.code],
    );
    if (existing) {throw new BadRequestException('region_exists');}

    await this.db.q(
      `INSERT INTO public.regions
         (code, name, currency, utc_offset_hours, launched,
          min_lat, max_lat, min_lng, max_lng, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        dto.code, dto.name.trim(), dto.currency, dto.utc_offset_hours ?? 0,
        // A new region defaults to NOT launched. Adding a region is preparation;
        // opening it to client bookings is a separate, deliberate act.
        dto.launched ?? false,
        box.box?.[0] ?? null, box.box?.[1] ?? null, box.box?.[2] ?? null, box.box?.[3] ?? null,
        req.admin.user_id,
      ],
    );
    await this.audit.recordAdmin(req.admin, 'region.create', 'system', dto.code, {
      name: dto.name, currency: dto.currency, launched: dto.launched ?? false,
      bbox: box.box ?? null,
    });
    await this.regions.refresh();
    await bumpConfigVersion(this.redis, 'regions');
    return {code: dto.code, ok: true};
  }

  @Patch(':code')
  @HttpCode(200)
  async update(@Param('code') codeParam: string, @Body() dto: UpdateRegionDto, @Req() req: OpsReq) {
    const code = (codeParam ?? '').trim().toUpperCase();
    const before = await this.db.qOne<Record<string, unknown>>(
      `SELECT code, name, currency, utc_offset_hours, launched,
              min_lat, max_lat, min_lng, max_lng
         FROM public.regions WHERE code = $1`, [code],
    );
    if (!before) {throw new BadRequestException('region_not_found');}

    const box = readBox(dto);
    if (!box.ok) {throw new BadRequestException(box.why);}
    if (dto.clear_bbox && box.box) {
      throw new BadRequestException('bbox_conflict: clear_bbox cannot be combined with box values');
    }

    // COALESCE on every optional so a PATCH carrying one field cannot blank the
    // rest — the classic partial-update data loss. The box is the exception: it
    // is replaced when supplied and cleared only on the explicit flag.
    const clearing = dto.clear_bbox === true;
    await this.db.q(
      `UPDATE public.regions
          SET name             = COALESCE($2, name),
              currency         = COALESCE($3, currency),
              utc_offset_hours = COALESCE($4, utc_offset_hours),
              launched         = COALESCE($5, launched),
              min_lat = CASE WHEN $10 THEN NULL WHEN $6::numeric IS NULL THEN min_lat ELSE $6 END,
              max_lat = CASE WHEN $10 THEN NULL WHEN $7::numeric IS NULL THEN max_lat ELSE $7 END,
              min_lng = CASE WHEN $10 THEN NULL WHEN $8::numeric IS NULL THEN min_lng ELSE $8 END,
              max_lng = CASE WHEN $10 THEN NULL WHEN $9::numeric IS NULL THEN max_lng ELSE $9 END,
              updated_at = NOW(),
              updated_by = $11
        WHERE code = $1`,
      [
        code, dto.name?.trim() ?? null, dto.currency ?? null,
        dto.utc_offset_hours ?? null, dto.launched ?? null,
        box.box?.[0] ?? null, box.box?.[1] ?? null, box.box?.[2] ?? null, box.box?.[3] ?? null,
        clearing, req.admin.user_id,
      ],
    );
    await this.audit.recordAdmin(req.admin, 'region.update', 'system', code, {
      from: before, to: {...dto},
    });
    await this.regions.refresh();
    await bumpConfigVersion(this.redis, 'regions');
    return {code, ok: true};
  }

  /**
   * Close a region to new bookings. There is no DELETE.
   *
   * Bookings, agents and compliance records reference `region_code`; removing the
   * row would orphan live history for a region someone once operated in. Same
   * rule as §45 of the family-credit spec and as member removal: status changes,
   * records stay.
   */
  @Delete(':code')
  @HttpCode(200)
  async close(@Param('code') codeParam: string, @Req() req: OpsReq) {
    const code = (codeParam ?? '').trim().toUpperCase();
    const row = await this.db.qOne<{launched: boolean}>(
      `UPDATE public.regions SET launched = false, updated_at = NOW(), updated_by = $2
        WHERE code = $1 RETURNING launched`,
      [code, req.admin.user_id],
    );
    if (!row) {throw new BadRequestException('region_not_found');}
    await this.audit.recordAdmin(req.admin, 'region.close', 'system', code, {launched: false});
    await this.regions.refresh();
    await bumpConfigVersion(this.redis, 'regions');
    return {code, launched: false};
  }
}
