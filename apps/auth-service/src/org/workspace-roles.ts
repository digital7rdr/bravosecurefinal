/**
 * 2026-10-27 (owner) — the three roles of an Enterprise workspace:
 *
 *   User    — member_role 'employee'. Channels they are added to, attendance,
 *             incident reports.
 *   Manager — member_role 'manager'. Runs the workspace's channels and
 *             members: create/edit channels and choose who is in them, add
 *             members, approve joins, suspend/reinstate Users.
 *   Admin   — member_role 'manager' + org_members.workspace_admin. Everything
 *             the owner can do except act on the owner: change anyone's role
 *             (User / Manager / Admin) and the status of Users and Managers.
 *             Only the owner changes or removes another Admin.
 *
 * Kept as flags on the manager row (see migration 20261027100000) because
 * every manager gate keys on member_role = 'manager' and an Admin must pass
 * all of them.
 */
export const WORKSPACE_MANAGER_MODULES = ['dept', 'roster', 'orgChart', 'msg'] as const;

/** SQL predicate: org `$col` is an Enterprise workspace. */
export const isWorkspaceOrgSql = (col: string): string =>
  `EXISTS (SELECT 1 FROM public.org_workspaces w_ WHERE w_.owner_user_id = ${col})`;
