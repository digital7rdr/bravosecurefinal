import {
  BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Req, UseGuards,
} from '@nestjs/common';
import type {Request} from 'express';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, Min,
  ValidateNested,
} from 'class-validator';
import {Type} from 'class-transformer';
import {Throttle} from '@nestjs/throttler';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {OPS_THROTTLE} from './ops-throttle';
import {AdminGuard, RequireRoles, type AdminContext} from './admin.guard';
import {DatabaseService} from '../database/database.service';
import {OpsAuditService} from './ops-audit.service';
import {RegionsService} from '../common/regions.service';
import {RedisService} from '../redis/redis.service';
import {bumpConfigVersion} from '../common/services/config-version';

type OpsReq = Request & {admin: AdminContext};

/**
 * B-788a — ops surface for Dispatch v2: operational AREAS under a region, the
 * PRIMARY / SECONDARY provider per area, and the per-region routing switch.
 *
 * Founder, 2026-09-03: "appoint a primary service provider for each province or
 * operational region, with a secondary provider available as backup … Bravo
 * should route according to assigned province/region and provider priority,
 * not a 50 km GPS restriction."
 *
 * Same guards, DTO validation and audit shape as OpsRegionsController. Every
 * write is attributable (`recordAdmin`). The routing flip also refreshes the
 * in-process regions cache and bumps the client config version, exactly as a
 * region edit does, so the switch is live on the next offer.
 */

class AreaBoxDto {
  @IsOptional() @IsNumber() @Min(-90)  @Max(90)  min_lat?: number;
  @IsOptional() @IsNumber() @Min(-90)  @Max(90)  max_lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) min_lng?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) max_lng?: number;
}

export class CreateAreaDto extends AreaBoxDto {
  @IsString() @Matches(/^[A-Z]{2,8}$/) region_code!: string;
  @IsString() @Matches(/^[A-Z]{2,8}(-[A-Z0-9]{1,8})?$/, {message: 'code like ZA-WC'}) code!: string;
  @IsString() @Length(1, 120) name!: string;
}

export class UpdateAreaDto extends AreaBoxDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

class AssignmentDto {
  @IsUUID() provider_user_id!: string;
  @IsInt() @Min(1) @Max(5) priority!: number;
}

export class SetAssignmentsDto {
  @IsArray() @ArrayMaxSize(5) @ValidateNested({each: true}) @Type(() => AssignmentDto)
  assignments!: AssignmentDto[];
}

export class RoutingModeDto {
  @IsIn(['nearest', 'assigned']) routing_mode!: 'nearest' | 'assigned';
}

function readBox(dto: AreaBoxDto): number[] | null {
  const vals = [dto.min_lat, dto.max_lat, dto.min_lng, dto.max_lng];
  const given = vals.filter(v => v !== undefined).length;
  if (given === 0) {return null;}
  if (given !== 4) {throw new BadRequestException('bbox needs all four of min_lat, max_lat, min_lng, max_lng');}
  const [a, b, c, d] = vals as number[];
  if (!(a < b && c < d)) {throw new BadRequestException('bbox must have min < max on both axes');}
  return [a, b, c, d];
}

interface AreaRow {
  id: string; region_code: string; code: string; name: string; is_default: boolean; active: boolean;
  min_lat: string | null; max_lat: string | null; min_lng: string | null; max_lng: string | null;
  updated_at: Date;
}
interface AssignmentRow {
  area_id: string; provider_user_id: string; priority: number; active: boolean;
  display_name: string | null; call_sign: string | null; provider_status: string; provider_region: string | null;
}
interface ProviderRow {
  user_id: string; display_name: string | null; call_sign: string | null; region_code: string | null; on_duty: boolean;
}

@Controller('ops/dispatch/areas')
// Ops console rate limiting (booking-lane critic 2026-09-04): bind a
// ThrottlerGuard subclass LAST (after JwtAuthGuard, so req.user is set when
// getTracker runs) so this surface is limited per USER. That binding is also
// what makes GlobalHttpThrottlerGuard.shouldSkip skip these routes — without it
// the whole console shares ONE per-IP bucket per office NAT, and this surface is
// polled by the console's AreasPanel.
@Throttle(OPS_THROTTLE)
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard, UserThrottlerGuard)
@RequireRoles('SUPERVISOR', 'ADMIN')
export class OpsDispatchAreasController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: OpsAuditService,
    private readonly regions: RegionsService,
    private readonly redis: RedisService,
  ) {}

  /** Everything the panel needs in one read: regions (with routing mode),
   *  areas with their assignments, and the ACTIVE company agents per region
   *  that can be assigned. */
  @Get()
  async list() {
    const [regions, areas, assignments, providers] = await Promise.all([
      this.db.q<{code: string; name: string; launched: boolean; routing_mode: string}>(
        `SELECT code, name, launched, routing_mode FROM public.regions ORDER BY code`,
      ),
      this.db.q<AreaRow>(
        `SELECT id, region_code, code, name, is_default, active, min_lat, max_lat, min_lng, max_lng, updated_at
           FROM public.operational_areas ORDER BY region_code, is_default DESC, code`,
      ),
      this.db.q<AssignmentRow>(
        `SELECT ap.area_id, ap.provider_user_id, ap.priority, ap.active,
                a.display_name, a.call_sign, a.status::text AS provider_status, a.region_code AS provider_region
           FROM public.area_provider_assignments ap
           JOIN public.agents a ON a.user_id = ap.provider_user_id
          WHERE ap.active = TRUE
          ORDER BY ap.area_id, ap.priority`,
      ),
      this.db.q<ProviderRow>(
        `SELECT user_id, display_name, call_sign, region_code, on_duty
           FROM public.agents
          WHERE type = 'company' AND status = 'ACTIVE'
          ORDER BY region_code, display_name`,
      ),
    ]);
    const byArea = new Map<string, AssignmentRow[]>();
    for (const a of assignments) {
      const list = byArea.get(a.area_id) ?? [];
      list.push(a);
      byArea.set(a.area_id, list);
    }
    return {
      regions,
      areas: areas.map(a => ({
        ...a,
        min_lat: a.min_lat === null ? null : Number(a.min_lat),
        max_lat: a.max_lat === null ? null : Number(a.max_lat),
        min_lng: a.min_lng === null ? null : Number(a.min_lng),
        max_lng: a.max_lng === null ? null : Number(a.max_lng),
        updated_at: a.updated_at?.toISOString?.() ?? String(a.updated_at),
        assignments: (byArea.get(a.id) ?? []).map(x => ({
          provider_user_id: x.provider_user_id, priority: x.priority,
          display_name: x.display_name, call_sign: x.call_sign,
          provider_status: x.provider_status, provider_region: x.provider_region,
        })),
      })),
      providers,
    };
  }

  @Post()
  async create(@Body() dto: CreateAreaDto, @Req() req: OpsReq) {
    const region = await this.db.qOne<{code: string}>(`SELECT code FROM public.regions WHERE code = $1`, [dto.region_code]);
    if (!region) {throw new NotFoundException('region_not_found');}
    if (!dto.code.startsWith(dto.region_code)) {
      throw new BadRequestException('code must start with the region code, e.g. ZA-WC');
    }
    const box = readBox(dto);
    if (!box) {
      // A region created after the areas migration has no catch-all yet: the
      // first box-less create becomes its default. A second one is refused.
      const existing = await this.db.qOne<{id: string}>(
        `SELECT id FROM public.operational_areas WHERE region_code = $1 AND is_default = TRUE`, [dto.region_code]);
      if (existing) {throw new BadRequestException('a drawn area needs a bounding box (the default area already exists)');}
    }
    const row = await this.db.qOne<{id: string}>(
      `INSERT INTO public.operational_areas
         (region_code, code, name, is_default, active, min_lat, max_lat, min_lng, max_lng, updated_by)
       VALUES ($1, $2, $3, $9, TRUE, $4, $5, $6, $7, $8)
       ON CONFLICT (code) DO NOTHING
       RETURNING id`,
      [dto.region_code, dto.code, dto.name, box?.[0] ?? null, box?.[1] ?? null, box?.[2] ?? null, box?.[3] ?? null,
       req.admin.user_id, box === null],
    );
    if (!row) {throw new BadRequestException('area_code_exists');}
    await this.audit.recordAdmin(req.admin, 'dispatch_area.create', 'system', dto.code, {
      region_code: dto.region_code, name: dto.name, bbox: box, is_default: box === null,
    });
    return {id: row.id, ok: true};
  }

  @Patch(':id')
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateAreaDto, @Req() req: OpsReq) {
    const cur = await this.db.qOne<AreaRow>(`SELECT * FROM public.operational_areas WHERE id = $1`, [id]);
    if (!cur) {throw new NotFoundException('area_not_found');}
    const box = readBox(dto);
    if (box && cur.is_default) {throw new BadRequestException('the default area has no box');}
    await this.db.q(
      `UPDATE public.operational_areas
          SET name = COALESCE($2, name),
              active = COALESCE($3, active),
              min_lat = COALESCE($4, min_lat), max_lat = COALESCE($5, max_lat),
              min_lng = COALESCE($6, min_lng), max_lng = COALESCE($7, max_lng),
              updated_at = NOW(), updated_by = $8
        WHERE id = $1`,
      [id, dto.name ?? null, dto.active ?? null,
       box?.[0] ?? null, box?.[1] ?? null, box?.[2] ?? null, box?.[3] ?? null, req.admin.user_id],
    );
    await this.audit.recordAdmin(req.admin, 'dispatch_area.update', 'system', cur.code, {
      ...(dto.name !== undefined ? {name: dto.name} : {}),
      ...(dto.active !== undefined ? {active: dto.active} : {}),
      ...(box ? {bbox: box} : {}),
    });
    return {ok: true};
  }

  /**
   * REPLACE the area's provider ladder. Providers must be ACTIVE company
   * agents in the area's region — the ranker's compliance gate is per region,
   * so an out-of-region assignment could never receive an offer and would only
   * hide the gap.
   */
  @Put(':id/assignments')
  async setAssignments(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetAssignmentsDto,
    @Req() req: OpsReq,
  ) {
    const area = await this.db.qOne<AreaRow>(`SELECT * FROM public.operational_areas WHERE id = $1`, [id]);
    if (!area) {throw new NotFoundException('area_not_found');}
    const priorities = dto.assignments.map(a => a.priority);
    if (new Set(priorities).size !== priorities.length) {throw new BadRequestException('duplicate priority');}
    const ids = dto.assignments.map(a => a.provider_user_id);
    if (new Set(ids).size !== ids.length) {throw new BadRequestException('duplicate provider');}
    if (ids.length > 0) {
      const ok = await this.db.q<{user_id: string}>(
        `SELECT user_id FROM public.agents
          WHERE user_id = ANY($1::uuid[]) AND type = 'company' AND status = 'ACTIVE' AND region_code = $2`,
        [ids, area.region_code],
      );
      if (ok.length !== ids.length) {
        throw new BadRequestException({
          code: 'provider_not_eligible',
          message: `Every provider must be an ACTIVE company agent in ${area.region_code}.`,
        });
      }
    }
    await this.db.withTransaction(async tx => {
      await tx.q(`DELETE FROM public.area_provider_assignments WHERE area_id = $1`, [id]);
      for (const a of dto.assignments) {
        await tx.q(
          `INSERT INTO public.area_provider_assignments (area_id, provider_user_id, priority, active, assigned_by)
           VALUES ($1, $2, $3, TRUE, $4)`,
          [id, a.provider_user_id, a.priority, req.admin.user_id],
        );
      }
    });
    await this.audit.recordAdmin(req.admin, 'dispatch_area.assign', 'system', area.code, {
      assignments: dto.assignments,
    });
    return {ok: true};
  }

  /** The per-region switch. 'assigned' = the priority cascade; 'nearest' =
   *  today's ranker, byte-identical. Refreshes the regions cache so the next
   *  offer routes the new way. */
  @Patch('routing-mode/:code')
  async setRoutingMode(@Param('code') code: string, @Body() dto: RoutingModeDto, @Req() req: OpsReq) {
    const c = code.trim().toUpperCase();
    const rows = await this.db.q<{code: string}>(
      `UPDATE public.regions SET routing_mode = $2, updated_at = NOW(), updated_by = $3 WHERE code = $1 RETURNING code`,
      [c, dto.routing_mode, req.admin.user_id],
    );
    if (rows.length === 0) {throw new NotFoundException('region_not_found');}
    await this.audit.recordAdmin(req.admin, 'region.routing_mode', 'system', c, {routing_mode: dto.routing_mode});
    await this.regions.refresh();
    await bumpConfigVersion(this.redis, 'regions');
    return {code: c, routing_mode: dto.routing_mode, ok: true};
  }
}
