import {Controller, Get, Param, ParseUUIDPipe, Query, Req, UseGuards} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import type {Request} from 'express';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {AdminGuard, RequireRoles, type AdminContext} from './admin.guard';
import {OpsSectionsService} from './ops-sections.service';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {OPS_THROTTLE} from './ops-throttle';

type OpsReq = Request & {admin: AdminContext};

/**
 * 2026-09-03 IA restructure — the read surfaces the re-sectioned console needs.
 * Same guard chain as every other /ops route (JwtAuthGuard → CsrfGuard →
 * AdminGuard); everything here is READ-ONLY, so nothing writes an audit row.
 *
 * Three gaps the audit found, one endpoint group each:
 *
 *  - IA-07 `GET /ops/config/status` — the App Configuration landing. Ops could
 *    edit pricing, regions, the package catalog and subscription prices from
 *    four different places and had no way to see WHAT the apps currently read
 *    or WHEN a change last landed.
 *  - IA-08 `GET /ops/agencies[/:id]` — provider agencies receive every Lite
 *    dispatch offer and had no page at all: only a filter value on /users.
 *  - SK-06(b)/OC-15 `GET /ops/enterprise/*` — enterprise_join_requests and the
 *    workspace tables are live data with zero ops visibility.
 *
 * Join-request DECISIONS are deliberately NOT here: approving one grants
 * workspace membership and seeds E2EE scope as an org manager
 * (EnterpriseJoinService.decideJoinRequest takes the org's own manager
 * identity). Whether an ops admin may act for a customer's workspace is a
 * product decision (audit §11 Q5) — until it is answered the console shows the
 * queue and says where it is worked.
 */
@Controller('ops')
// Ops console rate limiting (booking-lane critic 2026-09-04): bind a
// ThrottlerGuard subclass LAST (after JwtAuthGuard, so req.user is set when
// getTracker runs) so this surface is limited per USER. That binding is also
// what makes GlobalHttpThrottlerGuard.shouldSkip skip these routes — without it
// the whole console shares ONE per-IP bucket per office NAT.
@Throttle(OPS_THROTTLE)
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard, UserThrottlerGuard)
export class OpsSectionsController {
  constructor(private readonly sections: OpsSectionsService) {}

  /** IA-07 — one row per ops-changeable config: who changed it, when. */
  @Get('config/status')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  configStatus() {
    return this.sections.configStatus();
  }

  /** IA-08 — provider-agency roster with compliance + dispatch outcomes. */
  @Get('agencies')
  listAgencies(@Query('q') q?: string, @Query('limit') limit?: string) {
    return this.sections.listAgencies(q, Math.min(Number(limit) || 100, 500));
  }

  @Get('agencies/:id')
  getAgency(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    return this.sections.getAgency(id, req.admin);
  }

  /** Enterprise section landing counts. */
  @Get('enterprise/summary')
  enterpriseSummary() {
    return this.sections.enterpriseSummary();
  }

  /**
   * Enterprise organisations — the list behind /enterprise/departments and the
   * per-org detail (profile, channel tree, people, incidents, join requests,
   * attendance fold, audit feed). Read-only; message content never appears.
   */
  @Get('enterprise/orgs')
  listEnterpriseOrgs(@Query('q') q: string | undefined, @Query('limit') limit: string | undefined, @Req() req: OpsReq) {
    return this.sections.listEnterpriseOrgs(q, Math.min(Number(limit) || 200, 500), req.admin);
  }

  @Get('enterprise/orgs/:id')
  getEnterpriseOrg(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    return this.sections.getEnterpriseOrg(id, req.admin);
  }
  /** SK-06(b) — the cross-workspace pending join queue (read-only). */
  @Get('enterprise/join-requests')
  enterpriseJoinRequests(@Query('status') status?: string, @Query('limit') limit?: string) {
    return this.sections.listJoinRequests(status, Math.min(Number(limit) || 100, 500));
  }
}
