import {
  Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req,
  UseGuards, UseInterceptors,
} from '@nestjs/common';
import type {Request} from 'express';
import {Throttle} from '@nestjs/throttler';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {AdminGuard, RequireRoles, type AdminContext} from './admin.guard';
import {OpsAuditService} from './ops-audit.service';
import {OPS_THROTTLE} from './ops-throttle';
import {ReferralCampaignsService} from '../booking/referral-campaigns.service';
import {CreateReferralCampaignDto, UpdateReferralCampaignDto} from '../booking/dto/referral-campaign.dto';

type OpsReq = Request & {admin: AdminContext};

/**
 * Referral / discount campaign management (founder, 2026-09-05). Listing and
 * the per-campaign report are open to every admin tier (read-only); minting
 * and editing follow the config-surface gate (SUPERVISOR/ADMIN), the same as
 * pricing and the partner referral codes. Every mutation is audited.
 */
@Controller('ops/referral-campaigns')
// Ops console rate limiting: bind the ThrottlerGuard subclass LAST (after
// JwtAuthGuard) so the surface is limited per USER, not per office NAT.
@Throttle(OPS_THROTTLE)
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard, UserThrottlerGuard)
export class OpsReferralCampaignsController {
  constructor(
    private readonly campaigns: ReferralCampaignsService,
    private readonly audit: OpsAuditService,
  ) {}

  @Get()
  list() {
    return this.campaigns.list();
  }

  @Get('overview')
  overview() {
    return this.campaigns.overview();
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.detail(id);
  }

  @Post()
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  async create(@Body() dto: CreateReferralCampaignDto, @Req() req: OpsReq) {
    const row = await this.campaigns.create(req.admin.user_id, dto);
    await this.audit.recordAdmin(req.admin, 'referral_campaign.create', 'system', row.id, {
      code: row.code, scope: row.scope, region_code: row.region_code,
      discount_type: row.discount_type, discount_value: Number(row.discount_value),
      expires_at: row.expires_at,
    });
    // Founder 2026-09-05: a new campaign is announced to every eligible client.
    // The count is answered now; the fan-out runs on after the response (it
    // is minutes at scale, and a live campaign must not wait on it). A
    // scheduled campaign is not live yet — it skips, and the Notify button on
    // the campaign page sends it once it is.
    const eligible = await this.campaigns.countEligible();
    void this.campaigns.notifyEligible(row.id).catch(() => undefined);
    return {...row, eligible_clients: eligible};
  }

  /**
   * (Re)send the offer to every eligible client. Behind a 24 h cooldown so a
   * double press cannot blast twice; `force` is for a deliberate second wave.
   */
  @Post(':id/notify')
  @HttpCode(200)
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async notify(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: {force?: boolean},
    @Req() req: OpsReq,
  ) {
    const eligible = await this.campaigns.countEligible();
    const out = await this.campaigns.notifyEligible(id, {force: body?.force === true});
    await this.audit.recordAdmin(req.admin, 'referral_campaign.notify', 'system', id, {
      queued: out.queued, skipped: out.skipped, eligible, force: body?.force === true,
    });
    return {...out, eligible};
  }

  @Patch(':id')
  @HttpCode(200)
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReferralCampaignDto,
    @Req() req: OpsReq,
  ) {
    const row = await this.campaigns.update(id, dto);
    await this.audit.recordAdmin(req.admin, 'referral_campaign.update', 'system', row.id, {
      code: row.code, patch: dto,
    });
    return row;
  }
}
