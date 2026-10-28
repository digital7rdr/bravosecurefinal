/**
 * Workspace page rules (Bravo Web App, 2026-10-27) — kept out of the page
 * file so tests can load them and the page exports only its component.
 *
 * The server decides (OrgCpoService / OrgModuleGuard); these only hide the
 * buttons it would refuse.
 */
import type {WsMember} from './api';
import type {ManagedWorkspace} from './access';

export type Role = 'employee' | 'manager' | 'admin';

export const ROLE_LABEL: Record<Role, string> = {employee: 'User', manager: 'Manager', admin: 'Admin'};

/** What the server's refusals mean, in words. */
export function workspaceErrorText(e: unknown): string {
  const body = (e as {body?: {message?: string | string[]}})?.body;
  const code = Array.isArray(body?.message) ? body?.message[0] : body?.message ?? (e as Error)?.message ?? '';
  const map: Record<string, string> = {
    cannot_modify_org_owner: 'The workspace owner cannot be changed.',
    only_owner_or_admin_can_change_roles: 'Only the workspace owner or an Admin can change roles.',
    only_org_owner_can_change_admins: 'Only the workspace owner can change another Admin.',
    only_org_owner_can_demote_managers: 'Only the owner or an Admin can change a Manager.',
    only_org_owner_can_change_manager_status: 'Only the owner or an Admin can change a Manager’s status.',
    only_org_owner_can_change_admin_status: 'Only the workspace owner can change an Admin’s status.',
    member_not_active: 'Reinstate this member before changing their role.',
    role_changed_concurrently: 'Someone else changed this member at the same time. Refresh and try again.',
    suspend_reason_required: 'Give a reason for the suspension.',
    user_not_found: 'No Bravo account has that email or phone number. Ask them to sign up first (Lite is free).',
    already_a_member: 'They are already in this workspace.',
    provider_account_cannot_be_employee: 'That is a service-provider account; only personal Bravo accounts can join a workspace.',
    restricted_root_not_allowed: 'A top-level channel cannot be Restricted. Put it inside another channel, or choose Standard or Read only.',
    max_channel_depth_reached: 'That channel is already at the deepest level.',
    org_module_not_granted: 'Your manager role does not include this. Ask the workspace owner.',
  };
  const key = Object.keys(map).find(k => code.startsWith(k));
  return key ? map[key] : 'That did not work. Please try again.';
}

export function roleOf(m: WsMember): Role {
  return m.member_role === 'manager' ? (m.workspace_admin ? 'admin' : 'manager') : 'employee';
}

/** May someone at `level` change this member's role? */
export function canChangeRole(level: ManagedWorkspace['level'], m: WsMember): boolean {
  if (level === 'manager' || m.status !== 'active' || m.member_role === 'cpo') return false;
  return level === 'owner' || roleOf(m) !== 'admin';
}

/** May someone at `level` change this member's status? */
export function canChangeStatus(level: ManagedWorkspace['level'], m: WsMember): boolean {
  const r = roleOf(m);
  if (r === 'employee') return true;
  if (r === 'manager') return level !== 'manager';
  return level === 'owner';
}

