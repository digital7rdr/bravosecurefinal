import {
  Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Req, UseGuards,
} from '@nestjs/common';
import type {Request} from 'express';
import {Throttle} from '@nestjs/throttler';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {AdminGuard, RequireRoles, type AdminContext} from './admin.guard';
import {OPS_THROTTLE} from './ops-throttle';
import {OpsAuditService} from './ops-audit.service';
import {OpsEnterpriseStructureService} from './ops-enterprise-structure.service';
import {
  BulkPlacementDto, CreateStructureLateralDto, CreateStructureNodeDto, SetChannelTemplatesDto,
  SetLevelNamesDto, SetPlacementDto, UpdateStructureChannelDto,
} from './dto/enterprise-structure.dto';

type OpsReq = Request & {admin: AdminContext};

/**
 * Enterprise structure editor (2026-10-15) — build an organisation's channel
 * tree from the Bravo console: nodes (organisation › country › province ›
 * area), each level's template channels, and where each member sits.
 *
 * Path-scoped to /ops/enterprise, so AdminGuard's domain rule puts it in the
 * COMMUNICATION domain (COMMUNICATION_ADMIN and the all-domain roles). Reads
 * at any console rank; every write needs SUPERVISOR rank or above and lands in
 * ops_audit (who, from the console) as well as the organisation's own audit
 * trail (written by DepartmentService, naming the same admin).
 */
@Controller('ops/enterprise/orgs/:orgId/structure')
@Throttle(OPS_THROTTLE)
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard, UserThrottlerGuard)
export class OpsEnterpriseStructureController {
  constructor(
    private readonly structure: OpsEnterpriseStructureService,
    private readonly audit: OpsAuditService,
  ) {}

  @Get()
  get(@Param('orgId', ParseUUIDPipe) orgId: string, @Req() req: OpsReq) {
    return this.structure.structure(orgId, req.admin);
  }

  @Post('nodes')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async createNode(
    @Param('orgId', ParseUUIDPipe) orgId: string, @Body() body: CreateStructureNodeDto, @Req() req: OpsReq,
  ) {
    const out = await this.structure.createNode(orgId, req.admin, body);
    await this.audit.recordAdmin(req.admin, 'enterprise.structure.node_create', 'user', orgId, {
      channel_id: out.node.id, parent_id: body.parent_id ?? null, level: out.node.level,
      template_channels: out.laterals.created.length, template_failures: out.laterals.failed.length,
    });
    return out;
  }

  @Post('channels')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async createLateral(
    @Param('orgId', ParseUUIDPipe) orgId: string, @Body() body: CreateStructureLateralDto, @Req() req: OpsReq,
  ) {
    const out = await this.structure.createLateral(orgId, req.admin, body);
    await this.audit.recordAdmin(req.admin, 'enterprise.structure.channel_create', 'user', orgId, {
      channel_id: out.id, parent_id: body.parent_id, post_mode: out.post_mode,
    });
    return out;
  }

  @Patch('channels/:channelId')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async update(
    @Param('orgId', ParseUUIDPipe) orgId: string, @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body() body: UpdateStructureChannelDto, @Req() req: OpsReq,
  ) {
    const out = await this.structure.updateChannel(orgId, req.admin, channelId, body);
    await this.audit.recordAdmin(req.admin, 'enterprise.structure.channel_update', 'user', orgId, {
      channel_id: channelId, renamed: body.name !== undefined, post_mode: body.post_mode ?? null,
      access: body.access ?? null,
    });
    return out;
  }

  @Post('channels/:channelId/archive')
  @HttpCode(200)
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async archive(
    @Param('orgId', ParseUUIDPipe) orgId: string, @Param('channelId', ParseUUIDPipe) channelId: string,
    @Req() req: OpsReq,
  ) {
    const out = await this.structure.archive(orgId, req.admin, channelId);
    await this.audit.recordAdmin(req.admin, 'enterprise.structure.channel_archive', 'user', orgId, {channel_id: channelId});
    return out;
  }

  @Post('channels/:channelId/unarchive')
  @HttpCode(200)
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async unarchive(
    @Param('orgId', ParseUUIDPipe) orgId: string, @Param('channelId', ParseUUIDPipe) channelId: string,
    @Req() req: OpsReq,
  ) {
    const out = await this.structure.unarchive(orgId, req.admin, channelId);
    await this.audit.recordAdmin(req.admin, 'enterprise.structure.channel_unarchive', 'user', orgId, {channel_id: channelId});
    return out;
  }

  @Post('channels/:channelId/apply-template')
  @HttpCode(200)
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async applyTemplate(
    @Param('orgId', ParseUUIDPipe) orgId: string, @Param('channelId', ParseUUIDPipe) channelId: string,
    @Req() req: OpsReq,
  ) {
    const out = await this.structure.applyTemplate(orgId, req.admin, channelId);
    await this.audit.recordAdmin(req.admin, 'enterprise.structure.template_apply', 'user', orgId, {
      channel_id: channelId, created: out.created.length, failed: out.failed.length,
    });
    return out;
  }

  @Put('templates')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async setTemplates(
    @Param('orgId', ParseUUIDPipe) orgId: string, @Body() body: SetChannelTemplatesDto, @Req() req: OpsReq,
  ) {
    const out = await this.structure.setTemplates(orgId, req.admin, body);
    await this.audit.recordAdmin(req.admin, 'enterprise.structure.templates', 'user', orgId, {reset: body.reset === true});
    return out;
  }

  @Put('level-names')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async setLevelNames(
    @Param('orgId', ParseUUIDPipe) orgId: string, @Body() body: SetLevelNamesDto, @Req() req: OpsReq,
  ) {
    const out = await this.structure.setLevelNames(orgId, req.admin, body.names);
    await this.audit.recordAdmin(req.admin, 'enterprise.structure.level_names', 'user', orgId, {names: out.levelNames.join(' / ')});
    return out;
  }

  @Put('members/:userId/placement')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async place(
    @Param('orgId', ParseUUIDPipe) orgId: string, @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: SetPlacementDto, @Req() req: OpsReq,
  ) {
    const out = await this.structure.place(orgId, req.admin, [userId], body.channel_id ?? null);
    await this.audit.recordAdmin(req.admin, 'enterprise.structure.placement', 'user', orgId, {
      member_user_id: userId, channel_id: body.channel_id ?? null, ok: out.results[0]?.ok ?? false,
    });
    return out;
  }

  @Post('members/placement')
  @HttpCode(200)
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async placeMany(
    @Param('orgId', ParseUUIDPipe) orgId: string, @Body() body: BulkPlacementDto, @Req() req: OpsReq,
  ) {
    const out = await this.structure.place(orgId, req.admin, body.user_ids, body.channel_id ?? null);
    await this.audit.recordAdmin(req.admin, 'enterprise.structure.placement', 'user', orgId, {
      members: body.user_ids.length, channel_id: body.channel_id ?? null,
      failed: out.results.filter(r => !r.ok).length,
    });
    return out;
  }
}
