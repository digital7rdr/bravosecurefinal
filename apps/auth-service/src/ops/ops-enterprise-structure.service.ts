import {BadRequestException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {DepartmentService} from '../department/department.service';
import {WorkspaceService} from '../org/workspace.service';
import {
  DEFAULT_CHANNEL_TEMPLATES, effectiveTemplates, missingTemplates, normaliseTemplates,
  type ChannelTemplates, type ChannelTemplate,
} from '../department/channel-templates';
import type {ChannelAccess, ChannelPostMode, ChannelType} from '../department/dto/channel.dto';
import {assertRegionScope, type AdminContext} from './admin.guard';

/**
 * Enterprise structure editor (ops console, 2026-10-15).
 *
 * Founder request: build an organisation's channel tree — parent company,
 * countries/departments, provinces/sub-entities, areas — from the Bravo
 * console, with each level's standard channels created from a template and
 * each member placed at the node they belong to.
 *
 * EVERY WRITE GOES THROUGH DepartmentService, acting AS THE ORGANISATION
 * (exactly what the org owner does from the app) and naming the Bravo admin in
 * the org audit trail. Nothing here writes department_channels or memberships
 * directly: the depth/lateral/broadcast rules, the visibility rule and the
 * rekey-intent queue all live in that service, and a second writer is how
 * those invariants have been broken before.
 *
 * END-TO-END ENCRYPTION is unchanged: the server never holds a group key. A
 * channel created here is "waiting for encryption" until an organisation
 * admin's phone opens Channels (the existing self-heal sweep creates the
 * group), and membership changes are queued for that phone to apply.
 */

export interface StructureChannel {
  id: string;
  name: string;
  parent_id: string | null;
  level: number;
  is_lateral: boolean;
  is_broadcast: boolean;
  post_mode: ChannelPostMode;
  access: ChannelAccess;
  channel_type: ChannelType;
  archived: boolean;
  provisioned: boolean;
  member_count: number;
  created_at: string;
}

export interface StructureMember {
  user_id: string;
  display_name: string | null;
  member_role: string;
  department: string | null;
  placement_channel_id: string | null;
  /** 'org' = unplaced (whole organisation); 'missing' = the node is gone. */
  placement_state: 'org' | 'ok' | 'archived' | 'missing';
}

const MAX_BULK_PLACEMENT = 200;

@Injectable()
export class OpsEnterpriseStructureService {
  private readonly log = new Logger(OpsEnterpriseStructureService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly department: DepartmentService,
    private readonly workspace: WorkspaceService,
  ) {}

  /** The org must exist, be an organisation, and be inside the admin's region. */
  async assertOrg(orgId: string, admin: AdminContext): Promise<{
    id: string; display_name: string | null; workspace_name: string | null;
    home_region: string | null; is_workspace: boolean; is_agency: boolean;
  }> {
    const org = await this.db.qOne<{
      id: string; display_name: string | null; workspace_name: string | null;
      home_region: string | null; is_workspace: boolean; is_agency: boolean; is_enterprise: boolean;
    }>(
      `SELECT u.id, u.display_name, w.name AS workspace_name, u.home_region,
              (w.owner_user_id IS NOT NULL) AS is_workspace,
              (a.user_id IS NOT NULL) AS is_agency,
              (u.subscription_tier = 'enterprise') AS is_enterprise
         FROM public.users u
         LEFT JOIN public.org_workspaces w ON w.owner_user_id = u.id
         LEFT JOIN public.agents a ON a.user_id = u.id AND a.type = 'company'
        WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [orgId],
    );
    // Only an ORGANISATION has a channel tree. A plain user id here would let
    // the console mint a tree under any account.
    if (!org || !(org.is_workspace || org.is_agency || org.is_enterprise)) {
      throw new NotFoundException('organisation_not_found');
    }
    if (org.home_region) {assertRegionScope(admin, org.home_region);}
    return org;
  }

  async structure(orgId: string, admin: AdminContext) {
    const org = await this.assertOrg(orgId, admin);
    const [channels, members, settings] = await Promise.all([
      this.db.q<StructureChannel>(
        `SELECT c.id, c.name, c.parent_id, c.level, c.is_lateral, c.is_broadcast,
                c.post_mode, c.access, c.channel_type,
                (c.archived_at IS NOT NULL) AS archived,
                (c.group_conversation_id IS NOT NULL) AS provisioned,
                (SELECT COUNT(*)::int FROM public.department_channel_members m
                  WHERE m.channel_id = c.id) AS member_count,
                c.created_at
           FROM public.department_channels c
          WHERE c.org_id = $1
          ORDER BY c.level ASC, c.is_lateral ASC, c.created_at ASC
          LIMIT 2000`,
        [orgId],
      ),
      this.db.q<Omit<StructureMember, 'placement_state'>>(
        `SELECT m.member_user_id AS user_id, u.display_name, m.member_role, m.department,
                m.placement_channel_id
           FROM public.org_members m
           LEFT JOIN public.users u ON u.id = m.member_user_id
          WHERE m.org_user_id = $1 AND m.status = 'active'
          ORDER BY CASE m.member_role WHEN 'manager' THEN 0 ELSE 1 END, u.display_name ASC NULLS LAST
          LIMIT 2000`,
        [orgId],
      ),
      this.db.qOne<{channel_templates: unknown; level_names: string[] | null}>(
        `SELECT channel_templates, level_names FROM public.org_workspace_settings WHERE org_user_id = $1`,
        [orgId],
      ),
    ]);
    const byId = new Map(channels.map(c => [c.id, c]));
    const {templates, is_default} = effectiveTemplates(settings?.channel_templates);
    return {
      org,
      channels,
      members: members.map<StructureMember>(m => ({
        ...m,
        placement_state: !m.placement_channel_id ? 'org'
          : !byId.has(m.placement_channel_id) ? 'missing'
          : byId.get(m.placement_channel_id)!.archived ? 'archived' : 'ok',
      })),
      templates,
      templates_are_default: is_default,
      default_templates: DEFAULT_CHANNEL_TEMPLATES,
      level_names: settings?.level_names ?? [],
    };
  }

  /**
   * Add a node — the organisation itself (no parent) or a child of a node —
   * and, unless asked not to, its level's template channels as laterals.
   *
   * Template laterals are created one by one AFTER the node and a failure on
   * one is reported, not rolled back: the node is a real, usable chat on its
   * own, and "Apply template" fills any gap later (it skips names that exist).
   */
  async createNode(
    orgId: string, admin: AdminContext,
    input: {name: string; parent_id?: string | null; post_mode?: ChannelPostMode; apply_template?: boolean},
  ) {
    await this.assertOrg(orgId, admin);
    const name = cleanName(input.name);
    const node = await this.department.createChannel(orgId, orgId, {
      name,
      ...(input.parent_id ? {parent_id: input.parent_id} : {root: true}),
      // "Each node is also a chat": a node is a conversation for the people
      // placed there, so it defaults to open posting.
      post_mode: input.post_mode ?? 'open',
    }, admin.user_id);
    const laterals = input.apply_template === false
      ? {created: [], failed: []}
      : await this.applyTemplateTo(orgId, admin, node.id, node.level, []);
    return {node, laterals};
  }

  /** Add the template channels a node is still missing (by name). */
  async applyTemplate(orgId: string, admin: AdminContext, nodeId: string) {
    await this.assertOrg(orgId, admin);
    const node = await this.db.qOne<{level: number; is_lateral: boolean; is_broadcast: boolean; archived: boolean}>(
      `SELECT level, is_lateral, is_broadcast, (archived_at IS NOT NULL) AS archived
         FROM public.department_channels WHERE id = $1 AND org_id = $2`,
      [nodeId, orgId],
    );
    if (!node || node.archived) {throw new NotFoundException('channel_not_found');}
    if (node.is_lateral || node.is_broadcast) {throw new BadRequestException('template_needs_a_node');}
    const existing = await this.db.q<{name: string}>(
      `SELECT name FROM public.department_channels
        WHERE parent_id = $1 AND is_lateral AND archived_at IS NULL`,
      [nodeId],
    );
    return this.applyTemplateTo(orgId, admin, nodeId, node.level, existing.map(e => e.name));
  }

  private async applyTemplateTo(
    orgId: string, admin: AdminContext, nodeId: string, level: number, existingNames: string[],
  ): Promise<{created: Array<{id: string; name: string}>; failed: Array<{name: string; error: string}>}> {
    const templates = await this.templatesFor(orgId);
    const list: ChannelTemplate[] = templates[String(level) as keyof ChannelTemplates] ?? [];
    const created: Array<{id: string; name: string}> = [];
    const failed: Array<{name: string; error: string}> = [];
    for (const t of missingTemplates(list, existingNames)) {
      try {
        const ch = await this.department.createChannel(orgId, orgId, {
          name: t.name, parent_id: nodeId, lateral: true, post_mode: t.post_mode,
        }, admin.user_id);
        created.push({id: ch.id, name: t.name});
      } catch (e) {
        const error = (e as {response?: {message?: string}; message?: string})?.response?.message
          ?? (e as Error)?.message ?? 'create_failed';
        // Ids and the error code only: channel names are customer content.
        this.log.warn(`template lateral #${list.indexOf(t)} under ${nodeId} failed: ${error}`);
        failed.push({name: t.name, error: String(error)});
      }
    }
    return {created, failed};
  }

  async createLateral(
    orgId: string, admin: AdminContext,
    input: {parent_id: string; name: string; post_mode?: ChannelPostMode},
  ) {
    await this.assertOrg(orgId, admin);
    return this.department.createChannel(orgId, orgId, {
      name: cleanName(input.name), parent_id: input.parent_id, lateral: true,
      post_mode: input.post_mode ?? 'open',
    }, admin.user_id);
  }

  async updateChannel(
    orgId: string, admin: AdminContext, channelId: string,
    input: {name?: string; post_mode?: ChannelPostMode; access?: ChannelAccess},
  ) {
    await this.assertOrg(orgId, admin);
    return this.department.configureChannel(orgId, orgId, channelId, {
      ...(input.name !== undefined ? {name: cleanName(input.name)} : {}),
      ...(input.post_mode ? {post_mode: input.post_mode} : {}),
      ...(input.access ? {access: input.access} : {}),
    }, admin.user_id);
  }

  async archive(orgId: string, admin: AdminContext, channelId: string) {
    await this.assertOrg(orgId, admin);
    return this.department.archiveChannel(orgId, orgId, channelId, admin.user_id);
  }

  async unarchive(orgId: string, admin: AdminContext, channelId: string) {
    await this.assertOrg(orgId, admin);
    return this.department.unarchiveChannel(orgId, orgId, channelId, admin.user_id);
  }

  async templatesFor(orgId: string): Promise<ChannelTemplates> {
    const row = await this.db.qOne<{channel_templates: unknown}>(
      `SELECT channel_templates FROM public.org_workspace_settings WHERE org_user_id = $1`,
      [orgId],
    );
    return effectiveTemplates(row?.channel_templates).templates;
  }

  /** Whole-object replace (two editors cannot interleave); reset → defaults. */
  async setTemplates(orgId: string, admin: AdminContext, input: {templates?: unknown; reset?: boolean}) {
    await this.assertOrg(orgId, admin);
    let value: ChannelTemplates | Record<string, never>;
    if (input.reset) {
      value = {};
    } else {
      try {
        value = normaliseTemplates(input.templates);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
    }
    await this.db.q(
      `INSERT INTO public.org_workspace_settings (org_user_id, channel_templates, updated_by)
            VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (org_user_id) DO UPDATE
              SET channel_templates = EXCLUDED.channel_templates,
                  updated_by        = EXCLUDED.updated_by,
                  updated_at        = now()`,
      [orgId, JSON.stringify(value), admin.user_id],
    );
    return effectiveTemplates(value);
  }

  async setLevelNames(orgId: string, admin: AdminContext, names: unknown) {
    await this.assertOrg(orgId, admin);
    if (!Array.isArray(names)) {throw new BadRequestException('names_must_be_a_list');}
    return this.workspace.setLevelNames(orgId, admin.user_id, names.map(n => (typeof n === 'string' ? n : '')));
  }

  async place(orgId: string, admin: AdminContext, userIds: readonly string[], channelId: string | null) {
    await this.assertOrg(orgId, admin);
    if (userIds.length === 0) {throw new BadRequestException('no_members');}
    if (userIds.length > MAX_BULK_PLACEMENT) {throw new BadRequestException('too_many_members');}
    const results: Array<{user_id: string; ok: boolean; added?: number; removed?: number; error?: string}> = [];
    for (const userId of userIds) {
      try {
        const r = await this.department.applyPlacement(orgId, userId, channelId, admin.user_id);
        results.push({user_id: userId, ok: true, added: r.added, removed: r.removed});
      } catch (e) {
        const error = (e as {response?: {message?: string}; message?: string})?.response?.message
          ?? (e as Error)?.message ?? 'placement_failed';
        results.push({user_id: userId, ok: false, error: String(error)});
      }
    }
    return {results};
  }
}

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name || name.length > 80) {throw new BadRequestException('channel_name_1_to_80_chars');}
  return name;
}
