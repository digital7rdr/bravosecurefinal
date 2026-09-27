import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req, UseGuards,
} from '@nestjs/common';
import type {Request} from 'express';
import {IsString, Length, Matches} from 'class-validator';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {Throttle} from '@nestjs/throttler';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {OPS_THROTTLE} from '../ops/ops-throttle';
import {AdminGuard, RequireRoles, type AdminContext} from '../ops/admin.guard';
import {OpsAuditService} from '../ops/ops-audit.service';
import {SettingsService} from './settings.service';
import {CATALOG_BY_KEY, CATALOG_CATEGORIES} from './settings-catalog';
import {MessagingService} from '../messaging/messaging.service';
import {maskPhone} from '../messaging/messaging.types';

type OpsReq = Request & {admin: AdminContext};

class SetSettingDto {
  // Up to 8 KB covers a JSON blob or a long token; empty is rejected in-service
  // (clearing is DELETE, not an empty PUT).
  @IsString() @Length(1, 8192)
  value!: string;
}

class SmsTestDto {
  @IsString() @Matches(/^\+[1-9]\d{6,14}$/, {message: 'to must be an E.164 number, e.g. +971501234567'})
  to!: string;
}

/**
 * Runtime third-party integration config. SUPER_ADMIN only (rank-3 platform
 * admins; legacy ADMIN is the same rank). Secrets are AES-GCM encrypted at rest
 * and NEVER returned in clear — reads show a masked preview. Every write is
 * audited with the key and category, never the value.
 *
 * Registered in OpsModule (its guard chain + OpsAuditService), so the path is
 * /ops/settings alongside the rest of the console API.
 */
@Controller('ops/settings')
// Same per-USER ops rate as every other /ops controller (ops-throttle.binding.spec).
@Throttle(OPS_THROTTLE)
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard, UserThrottlerGuard)
@RequireRoles('SUPER_ADMIN')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: OpsAuditService,
    private readonly messaging: MessagingService,
  ) {}

  @Get()
  async list() {
    return {
      encryptionAvailable: this.settings.encryptionAvailable,
      encryptionReason: this.settings.encryptionUnavailableReason,
      categories: CATALOG_CATEGORIES,
      settings: await this.settings.status(),
    };
  }

  @Put(':key')
  async set(@Param('key') key: string, @Body() dto: SetSettingDto, @Req() req: OpsReq) {
    if (!CATALOG_BY_KEY.has(key)) {throw new BadRequestException('unknown_setting');}
    const def = CATALOG_BY_KEY.get(key)!;
    try {
      await this.settings.set(key, dto.value, req.admin.user_id);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    await this.audit.recordAdmin(req.admin, 'integration.setting.set', 'system', key, {
      category: def.category, secret: def.secret,
    });
    const settings = await this.settings.status();
    return {ok: true, setting: settings.find(s => s.key === key) ?? null};
  }

  @Delete(':key')
  async clear(@Param('key') key: string, @Req() req: OpsReq) {
    if (!CATALOG_BY_KEY.has(key)) {throw new BadRequestException('unknown_setting');}
    const def = CATALOG_BY_KEY.get(key)!;
    try {
      await this.settings.clear(key, req.admin.user_id);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    await this.audit.recordAdmin(req.admin, 'integration.setting.clear', 'system', key, {
      category: def.category, secret: def.secret,
    });
    const settings = await this.settings.status();
    return {ok: true, setting: settings.find(s => s.key === key) ?? null};
  }

  /**
   * Send one test SMS with the saved Twilio credentials, so an admin can
   * confirm delivery after changing a key. Audited with the number masked.
   */
  @Post('sms/test')
  @HttpCode(200)
  async testSms(@Body() dto: SmsTestDto, @Req() req: OpsReq) {
    let ok = false;
    let error: string | null = null;
    try {
      await this.messaging.sendSms(dto.to, 'Bravo Secure: test message from the ops console. SMS delivery is working.');
      ok = true;
    } catch (e) {
      error = (e as Error).message.slice(0, 300);
    }
    await this.audit.recordAdmin(req.admin, 'integration.sms.test', 'system', 'twilio.sms', {
      ok, to: maskPhone(dto.to),
    });
    return {ok, error};
  }
}
