import {Controller, Get, Param} from '@nestjs/common';
import {ReferralCampaignsService} from './referral-campaigns.service';

/**
 * The deep-link landing resolve — UNAUTHENTICATED on purpose.
 *
 * A referral link is shared to people who do not have the app yet, so the
 * landing page (ops-console `/r/:code`) must be able to say "20% off in Dubai"
 * before any account exists. It reveals ONLY what a poster would: the
 * campaign's name, discount and region. Usage figures, notes and everything
 * else stay behind the ops guard. Invalid, inactive and expired codes all
 * collapse to `{valid:false}` so the route is not an oracle for which codes
 * exist. Rate-limited by the global per-IP throttler like every public route.
 */
@Controller('referrals')
export class ReferralsPublicController {
  constructor(private readonly campaigns: ReferralCampaignsService) {}

  @Get('public/:code')
  resolve(@Param('code') code: string) {
    return this.campaigns.publicResolve(code);
  }
}
