import {
  Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import {IsBoolean, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength} from 'class-validator';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {OrgManagerGuard, type OrgManagerContext} from './org-manager.guard';
import {CurrentOrgManager} from './current-org-manager.decorator';
import {OrgModules} from './org-module.guard';
import {OrgFleetService} from './org-fleet.service';
import {OrgProviderExtrasService} from './org-provider-extras.service';

export class CreateOrgVehicleDto {
  @IsString() @MinLength(1) @MaxLength(24) call_sign!: string;
  @IsString() @MinLength(2) @MaxLength(80) make_model!: string;
  @IsString() @MinLength(2) @MaxLength(20) plate!: string;
  @IsOptional() @IsString() @MaxLength(40) colour?: string | null;
  @IsOptional() @IsBoolean() armored?: boolean;
  @IsOptional() @IsString() @MaxLength(20) armor_grade?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(20) capacity?: number;
  @IsOptional() @IsString() @Matches(/^[A-Z]{2}(-[A-Z0-9]{1,4})?$/) region_code?: string | null;
}

export class UpdateOrgVehicleDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(24) call_sign?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) make_model?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(20) plate?: string;
  @IsOptional() @IsString() @MaxLength(40) colour?: string | null;
  @IsOptional() @IsBoolean() armored?: boolean;
  @IsOptional() @IsString() @MaxLength(20) armor_grade?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(20) capacity?: number;
  @IsOptional() @IsString() @Matches(/^[A-Z]{2}(-[A-Z0-9]{1,4})?$/) region_code?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class AssignOrgVehicleDto {
  @IsUUID() vehicle_id!: string;
}

/**
 * Provider console Phase 2 (2026-10-03): vehicles, Secure Pro work, payout
 * statement. Same stack as OrgController — JwtAuthGuard → CsrfGuard (cookie
 * sessions) → OrgManagerGuard (the org comes from here, never the request) —
 * plus @OrgModules on every route.
 */
@Controller('org')
@UseGuards(JwtAuthGuard, CsrfGuard, OrgManagerGuard, UserThrottlerGuard)
export class OrgProviderController {
  constructor(
    private readonly fleet: OrgFleetService,
    private readonly extras: OrgProviderExtrasService,
  ) {}

  // ── Vehicles ────────────────────────────────────────────────────────────
  // Reading the list also serves the vehicle picker on a mission (Missions).
  @OrgModules('fleet', 'jobs')
  @Get('fleet/vehicles')
  listVehicles(@CurrentOrgManager() m: OrgManagerContext) {
    return this.fleet.list(m.org_user_id);
  }

  @OrgModules('fleet')
  @Post('fleet/vehicles')
  createVehicle(@Body() dto: CreateOrgVehicleDto, @CurrentOrgManager() m: OrgManagerContext) {
    return this.fleet.create(m.org_user_id, m.user_id, dto);
  }

  @OrgModules('fleet')
  @Patch('fleet/vehicles/:id')
  @HttpCode(200)
  updateVehicle(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrgVehicleDto,
    @CurrentOrgManager() m: OrgManagerContext,
  ) {
    return this.fleet.update(m.org_user_id, id, dto);
  }

  @OrgModules('jobs', 'fleet')
  @Get('fleet/missions/:missionId')
  missionVehicles(@Param('missionId', ParseUUIDPipe) missionId: string, @CurrentOrgManager() m: OrgManagerContext) {
    return this.fleet.missionVehicles(m.org_user_id, missionId);
  }

  @OrgModules('jobs')
  @Post('fleet/missions/:missionId/vehicles')
  @HttpCode(200)
  assignVehicle(
    @Param('missionId', ParseUUIDPipe) missionId: string,
    @Body() dto: AssignOrgVehicleDto,
    @CurrentOrgManager() m: OrgManagerContext,
  ) {
    return this.fleet.assign(m.org_user_id, m.user_id, missionId, dto.vehicle_id);
  }

  @OrgModules('jobs')
  @Post('fleet/missions/:missionId/vehicles/:vehicleId/release')
  @HttpCode(200)
  releaseVehicle(
    @Param('missionId', ParseUUIDPipe) missionId: string,
    @Param('vehicleId', ParseUUIDPipe) vehicleId: string,
    @CurrentOrgManager() m: OrgManagerContext,
  ) {
    return this.fleet.release(m.org_user_id, missionId, vehicleId);
  }

  // ── Secure Pro ──────────────────────────────────────────────────────────
  @OrgModules('pro')
  @Get('pro/assignments')
  proAssignments(@Query('scope') scope: string | undefined, @CurrentOrgManager() m: OrgManagerContext) {
    return this.extras.proAssignments(m.org_user_id, scope === 'past' ? 'past' : 'current');
  }

  // ── Finance ─────────────────────────────────────────────────────────────
  @OrgModules('earn')
  @Get('statement')
  statement(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @CurrentOrgManager() m: OrgManagerContext,
  ) {
    return this.extras.statement(m.org_user_id, from, to);
  }
}


