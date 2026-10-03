import {Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards} from '@nestjs/common';
import type {Request} from 'express';
import {Throttle} from '@nestjs/throttler';
import {IsIn, IsOptional, IsString, MaxLength} from 'class-validator';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {AdminGuard, RequireRoles, type AdminContext} from '../ops/admin.guard';
import {OpsAuditService} from '../ops/ops-audit.service';
import {OPS_THROTTLE} from '../ops/ops-throttle';
import {OrgFleetService} from './org-fleet.service';

export class ReviewOrgVehicleDto {
  @IsIn(['verified', 'rejected']) decision!: 'verified' | 'rejected';
  @IsOptional() @IsString() @MaxLength(280) note?: string;
}

/**
 * HQ review of agency vehicles (provider console Phase 2, 2026-10-03).
 * /ops/agencies/* is the operations domain (admin.guard domainOfPath), so an
 * Operation Admin or Super Admin reviews; SUPERVISOR rank and above. Audited.
 */
@Controller('ops/agencies/vehicles')
@Throttle(OPS_THROTTLE)
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard, UserThrottlerGuard)
@RequireRoles('SUPERVISOR')
export class OpsProviderFleetController {
  constructor(
    private readonly fleet: OrgFleetService,
    private readonly audit: OpsAuditService,
  ) {}

  @Get()
  list(@Query('status') status?: string) {
    const s = status === 'verified' || status === 'rejected' || status === 'all' ? status : 'pending';
    return this.fleet.listForReview(s);
  }

  @Post(':id/review')
  @HttpCode(200)
  async review(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewOrgVehicleDto,
    @Req() req: Request & {admin: AdminContext},
  ) {
    const out = await this.fleet.review(req.admin.user_id, id, dto.decision, dto.note);
    // Subject = the agency (ops_audit_subject_type_chk has no vehicle type);
    // the vehicle id rides in the metadata.
    const orgId = (out.vehicle as {org_user_id?: string}).org_user_id ?? id;
    await this.audit.recordAdmin(req.admin, `agency.vehicle.${dto.decision}`, 'user', orgId, {
      vehicle_id: id,
      ...(dto.note ? {note: dto.note} : {}),
    });
    return out;
  }
}
