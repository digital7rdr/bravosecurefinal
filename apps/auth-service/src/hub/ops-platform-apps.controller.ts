import {Body, Controller, Get, Param, Patch, Req, UseGuards} from '@nestjs/common';
import type {Request} from 'express';
import {Throttle} from '@nestjs/throttler';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength,
  ValidateIf,
} from 'class-validator';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {OPS_THROTTLE} from '../ops/ops-throttle';
import {AdminGuard, RequireRoles, type AdminContext} from '../ops/admin.guard';
import {OpsAuditService} from '../ops/ops-audit.service';
import {APP_ICONS, AUDIENCES, HubService} from './hub.service';

type OpsReq = Request & {admin: AdminContext};

class UpdateAppDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60) name?: string;
  @IsOptional() @IsString() @MaxLength(80) tagline?: string;
  @IsOptional() @IsIn(APP_ICONS as unknown as string[]) icon?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) sort?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  // null clears the address; a string must be http(s) (checked again in the service).
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @Matches(/^https?:\/\/\S+$/) @MaxLength(300) url?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @Matches(/^https?:\/\/\S+$/) @MaxLength(300) agency_url?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(4) @IsIn(AUDIENCES as unknown as string[], {each: true}) allowed_audiences?: string[];
  @IsOptional() @IsBoolean() requires_totp?: boolean;
}

/**
 * Super Admin: the tiles on the Bravo Secure home site (ops console →
 * Internal → Apps). Which apps are active, where they open, and which kinds of
 * account may open them. Every change is audited with the before/after values.
 */
@Controller('ops/platform-apps')
@Throttle(OPS_THROTTLE)
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard, UserThrottlerGuard)
@RequireRoles('SUPER_ADMIN')
export class OpsPlatformAppsController {
  constructor(
    private readonly hub: HubService,
    private readonly audit: OpsAuditService,
  ) {}

  @Get()
  async list() {
    return {apps: await this.hub.listApps(), audiences: AUDIENCES, icons: APP_ICONS};
  }

  @Patch(':key')
  async update(@Param('key') key: string, @Body() dto: UpdateAppDto, @Req() req: OpsReq) {
    const {before, after} = await this.hub.updateApp(key, dto, req.admin.user_id);
    const changed: Record<string, {from: unknown; to: unknown}> = {};
    for (const k of Object.keys(dto) as Array<keyof UpdateAppDto>) {
      const a = (before as unknown as Record<string, unknown>)[k];
      const b = (after as unknown as Record<string, unknown>)[k];
      if (JSON.stringify(a) !== JSON.stringify(b)) changed[k] = {from: a, to: b};
    }
    await this.audit.recordAdmin(req.admin, 'platform.app.update', 'system', `platform_app:${key}`, {changed});
    return {app: after};
  }
}
