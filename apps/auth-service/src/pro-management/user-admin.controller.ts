import {Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards} from '@nestjs/common';
import type {Request} from 'express';
import {IsEmail, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf} from 'class-validator';
import {Throttle} from '@nestjs/throttler';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {AdminGuard, RequireRoles, type AdminContext} from '../ops/admin.guard';
import {OpsAuditService} from '../ops/ops-audit.service';
import {OPS_THROTTLE} from '../ops/ops-throttle';
import {UserAdminService, type AppAccountType} from './user-admin.service';
import {DatabaseService} from '../database/database.service';
import {applyIdentityEdit} from './identity-edit';

type OpsReq = Request & {admin: AdminContext};

export class CreateAppUserDto {
  @IsIn(['individual', 'agency', 'cpo']) account_type!: AppAccountType;
  @IsString() @MinLength(2) @MaxLength(120) display_name!: string;
  @IsEmail() email!: string;
  @Matches(/^\+\d{6,15}$/, {message: 'phone must be E.164, e.g. +971501234567'}) phone_e164!: string;
  @ValidateIf(o => o.account_type === 'cpo') @IsUUID() agency_user_id?: string;
  @IsOptional() @IsString() @Matches(/^[A-Z]{2}$/) coverage_country?: string;
  @IsOptional() @IsString() @MaxLength(24) call_sign?: string;
}

/** Edit name / email / login phone (2026-10-10). Every field optional. */
export class UpdateUserProfileDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) display_name?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @Matches(/^\+\d{6,15}$/, {message: 'phone must be E.164, e.g. +971501234567'}) phone_e164?: string;
}

/**
 * Create app accounts from the console as SMS invites (no admin passwords).
 * SUPER_ADMIN (rank 3) — the "mints accounts" rank in admin.guard. Audited.
 * Suspend / restore / erase stay where they were (ops-data.controller).
 */
@Controller('ops/users')
@Throttle(OPS_THROTTLE)
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard, UserThrottlerGuard)
@RequireRoles('SUPER_ADMIN')
export class UserAdminController {
  constructor(
    private readonly users: UserAdminService,
    private readonly audit: OpsAuditService,
    // Appended last (specs construct this controller positionally).
    private readonly db?: DatabaseService,
  ) {}

  /**
   * Edit a user's name, email or login phone (People → Users → user). The
   * changed email/phone counts as unverified until the person receives a code
   * on it. Audited with the old/new values masked.
   */
  @Patch(':id/profile')
  async updateProfile(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserProfileDto, @Req() req: OpsReq) {
    const out = await applyIdentityEdit(this.db!, id, dto);
    if (out.changed.length) await this.audit.recordAdmin(req.admin, 'user.profile.update', 'user', id, {changed: out.audit});
    return {ok: true, changed: out.changed};
  }

  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateAppUserDto, @Req() req: OpsReq) {
    const out = await this.users.createUser(req.admin, dto);
    await this.audit.recordAdmin(req.admin, 'user.create', 'user', out.user_id, {
      account_type: dto.account_type, invite: true, sms_sent: out.sms_sent,
      ...(dto.agency_user_id ? {agency_user_id: dto.agency_user_id} : {}),
    });
    return out;
  }

  @Get(':id/invite')
  invite(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.inviteStatus(id);
  }

  /**
   * First sign-in password for a pending invite (SMS off / not received).
   * Shown to the admin ONCE; never stored in clear, never in the audit row.
   */
  @Post(':id/invite/password')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Throttle({default: {limit: 10, ttl: 60_000}})
  async issuePassword(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    const out = await this.users.issueInvitePassword(req.admin, id);
    await this.audit.recordAdmin(req.admin, 'user.invite.password_issued', 'user', id, {account_type: out.account_type});
    return out;
  }

  @Post(':id/invite/resend')
  async resend(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    const out = await this.users.resendInvite(req.admin, id);
    await this.audit.recordAdmin(req.admin, 'user.invite.resend', 'user', id, {sms_sent: out.sms_sent});
    return out;
  }
}
