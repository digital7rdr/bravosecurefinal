import {Body, Controller, Get, Param, ParseUUIDPipe, Put, Req, UseGuards} from '@nestjs/common';
import type {Request} from 'express';
import {IsBoolean, ValidateIf} from 'class-validator';
import {Throttle} from '@nestjs/throttler';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {AdminGuard, RequireRoles, type AdminContext} from '../ops/admin.guard';
import {OpsAuditService} from '../ops/ops-audit.service';
import {OPS_THROTTLE} from '../ops/ops-throttle';
import {ModuleAccessService} from './module-access.service';

type OpsReq = Request & {admin: AdminContext};

class SetGroupModuleDto {
  @IsBoolean() enabled!: boolean;
}

class SetUserModuleDto {
  /** true / false = override; null = remove the override (follow the group). */
  @ValidateIf((_o, v) => v !== null) @IsBoolean()
  enabled!: boolean | null;
}

/**
 * Module Access — which product modules each account group (and, by override,
 * each user) may use. SUPER_ADMIN (rank 3; legacy ADMIN is the same rank).
 * Every change is audited. Registered in OpsModule for its guard chain.
 */
@Controller('ops/module-access')
@Throttle(OPS_THROTTLE)
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard, UserThrottlerGuard)
@RequireRoles('SUPER_ADMIN')
export class ModuleAccessController {
  constructor(
    private readonly access: ModuleAccessService,
    private readonly audit: OpsAuditService,
  ) {}

  @Get()
  matrix() {
    return this.access.matrixView();
  }

  @Put('groups/:group/:module')
  async setGroup(
    @Param('group') group: string,
    @Param('module') module: string,
    @Body() dto: SetGroupModuleDto,
    @Req() req: OpsReq,
  ) {
    await this.access.setGroupModule(group, module, dto.enabled, req.admin.user_id);
    await this.audit.recordAdmin(req.admin, 'module_access.group.set', 'system', `${group}:${module}`, {
      group, module, enabled: dto.enabled,
    });
    return {ok: true};
  }

  @Get('users/:userId')
  user(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.access.userView(userId);
  }

  @Put('users/:userId/:module')
  async setUser(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('module') module: string,
    @Body() dto: SetUserModuleDto,
    @Req() req: OpsReq,
  ) {
    const group = await this.access.setUserOverride(userId, module, dto.enabled, req.admin.user_id);
    await this.audit.recordAdmin(req.admin, 'module_access.user.set', 'user', userId, {
      module, group, enabled: dto.enabled,
    });
    return {ok: true, view: await this.access.userView(userId)};
  }
}
