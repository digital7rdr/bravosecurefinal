import {
  Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req,
  UseGuards, UseInterceptors,
} from '@nestjs/common';
import type {Request} from 'express';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import {AdminGuard, RequireRoles, type AdminContext} from './admin.guard';
import {ReferralCodesService} from './referral-codes.service';
import {CreateReferralCodeDto, SetReferralCodeActiveDto} from './dto/ops.dto';
import {Throttle} from '@nestjs/throttler';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {OPS_THROTTLE} from './ops-throttle';

type OpsReq = Request & {admin: AdminContext};

/**
 * Issue 28 — partner / referral code management. Listing is open to any
 * admin (read-only); minting and (de)activation follow the config-surface
 * gate (SUPERVISOR/ADMIN, same as subscription pricing).
 */
@Controller('ops/referral-codes')
// Ops console rate limiting (booking-lane critic 2026-09-04): bind a
// ThrottlerGuard subclass LAST (after JwtAuthGuard, so req.user is set when
// getTracker runs) so this surface is limited per USER. That binding is also
// what makes GlobalHttpThrottlerGuard.shouldSkip skip these routes — without it
// the whole console shares ONE per-IP bucket per office NAT.
@Throttle(OPS_THROTTLE)
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard, UserThrottlerGuard)
export class ReferralCodesController {
  constructor(private readonly codes: ReferralCodesService) {}

  @Get()
  list() {
    return this.codes.list();
  }

  @Post()
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  create(@Body() dto: CreateReferralCodeDto, @Req() req: OpsReq) {
    return this.codes.create(req.admin, dto);
  }

  @Patch(':id/active')
  @HttpCode(200)
  @RequireRoles('SUPERVISOR', 'ADMIN')
  setActive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetReferralCodeActiveDto,
    @Req() req: OpsReq,
  ) {
    return this.codes.setActive(req.admin, id, dto.active);
  }
}
