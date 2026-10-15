import {
  Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards,
} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {OrgManagerGuard, type OrgManagerContext} from '../org/org-manager.guard';
import {CurrentOrgManager} from '../org/current-org-manager.decorator';
import {OrgModules} from '../org/org-module.guard';
import {OpsEnterpriseStructureService} from './ops-enterprise-structure.service';
import {
  BulkPlacementDto, CreateStructureLateralDto, CreateStructureNodeDto, SetChannelTemplatesDto,
  SetLevelNamesDto, UpdateStructureChannelDto,
} from './dto/enterprise-structure.dto';

/**
 * Departments for the organisation's OWN admins (provider console, 2026-10-15).
 *
 * Owner report: "I don't see the departments in the provider account." The
 * structure editor existed only in the Bravo console. This is the same editor
 * for the organisation itself — the agency owner (or workspace owner) and its
 * UNSCOPED managers. OrgManagerGuard resolves which organisation from the
 * X-Org-Context header and refuses anyone who does not administer it, so the
 * org id is never taken from the URL or the body.
 *
 * A manager delegated to ONE department (org_members.department set) may read
 * the structure but not change it: reshaping the whole tree, or moving people
 * between branches, is wider than their delegation.
 *
 * Delegated managers also need the Departmental or Org chart module granted
 * by the owner (OrgModuleGuard), like every other console section.
 *
 * Every write goes through the same service as the console's, so the rules
 * (depth, laterals, placement, rekey intents, audit naming the person) are
 * identical whoever makes the change.
 */
@Controller('org/structure')
@UseGuards(JwtAuthGuard, CsrfGuard, OrgManagerGuard)
export class OrgStructureController {
  constructor(private readonly structure: OpsEnterpriseStructureService) {}

  private static writer(m: OrgManagerContext): {user_id: string} {
    if (m.department !== null) {throw new ForbiddenException('department_manager_cannot_edit_structure');}
    return {user_id: m.user_id};
  }

  @OrgModules('dept', 'orgChart')
  @Get()
  async get(@CurrentOrgManager() m: OrgManagerContext) {
    const out = await this.structure.structure(m.org_user_id, {user_id: m.user_id});
    return {...out, can_edit: m.department === null};
  }

  @OrgModules('dept', 'orgChart')
  @Post('nodes')
  createNode(@CurrentOrgManager() m: OrgManagerContext, @Body() body: CreateStructureNodeDto) {
    return this.structure.createNode(m.org_user_id, OrgStructureController.writer(m), body);
  }

  @OrgModules('dept', 'orgChart')
  @Post('channels')
  createLateral(@CurrentOrgManager() m: OrgManagerContext, @Body() body: CreateStructureLateralDto) {
    return this.structure.createLateral(m.org_user_id, OrgStructureController.writer(m), body);
  }

  @OrgModules('dept', 'orgChart')
  @Patch('channels/:channelId')
  update(
    @CurrentOrgManager() m: OrgManagerContext, @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body() body: UpdateStructureChannelDto,
  ) {
    return this.structure.updateChannel(m.org_user_id, OrgStructureController.writer(m), channelId, body);
  }

  @OrgModules('dept', 'orgChart')
  @Post('channels/:channelId/archive')
  @HttpCode(200)
  archive(@CurrentOrgManager() m: OrgManagerContext, @Param('channelId', ParseUUIDPipe) channelId: string) {
    return this.structure.archive(m.org_user_id, OrgStructureController.writer(m), channelId);
  }

  @OrgModules('dept', 'orgChart')
  @Post('channels/:channelId/unarchive')
  @HttpCode(200)
  unarchive(@CurrentOrgManager() m: OrgManagerContext, @Param('channelId', ParseUUIDPipe) channelId: string) {
    return this.structure.unarchive(m.org_user_id, OrgStructureController.writer(m), channelId);
  }

  @OrgModules('dept', 'orgChart')
  @Post('channels/:channelId/apply-template')
  @HttpCode(200)
  applyTemplate(@CurrentOrgManager() m: OrgManagerContext, @Param('channelId', ParseUUIDPipe) channelId: string) {
    return this.structure.applyTemplate(m.org_user_id, OrgStructureController.writer(m), channelId);
  }

  @OrgModules('dept', 'orgChart')
  @Put('templates')
  setTemplates(@CurrentOrgManager() m: OrgManagerContext, @Body() body: SetChannelTemplatesDto) {
    return this.structure.setTemplates(m.org_user_id, OrgStructureController.writer(m), body);
  }

  @OrgModules('dept', 'orgChart')
  @Put('level-names')
  setLevelNames(@CurrentOrgManager() m: OrgManagerContext, @Body() body: SetLevelNamesDto) {
    return this.structure.setLevelNames(m.org_user_id, OrgStructureController.writer(m), body.names);
  }

  @OrgModules('dept', 'orgChart')
  @Post('members/placement')
  @HttpCode(200)
  place(@CurrentOrgManager() m: OrgManagerContext, @Body() body: BulkPlacementDto) {
    return this.structure.place(m.org_user_id, OrgStructureController.writer(m), body.user_ids, body.channel_id ?? null);
  }
}
