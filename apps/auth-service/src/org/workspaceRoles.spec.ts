/**
 * 2026-10-27 (owner) — workspace roles and manager routing:
 *   - a workspace manager is NOT an agency operator (no Manager Dashboard),
 *   - a workspace manager starts with the workspace grant,
 *   - User / Manager / Admin role changes and who may make them,
 *   - an Admin stands in for the owner in OrgModuleGuard.
 */
import 'reflect-metadata';
import {Test} from '@nestjs/testing';
import type {ExecutionContext} from '@nestjs/common';
import type {Reflector} from '@nestjs/core';
import {deriveAccountKind, resolveIsAgencyManager, type AccountKindRow} from '../auth/account-kind';
import {OrgCpoService} from './org-cpo.service';
import {OrgModuleGuard, ORG_OWNER_ONLY} from './org-module.guard';
import {DatabaseService} from '../database/database.service';
import {PasswordService} from '../common/services/password.service';
import {DepartmentService} from '../department/department.service';
import {AuthService} from '../auth/auth.service';
import {OrgAuditService} from './org-audit.service';
import {WORKSPACE_MANAGER_MODULES} from './workspace-roles';

const baseRow = (o: Partial<AccountKindRow>): AccountKindRow => ({
  user_role: 'individual', agent_type: null, agent_status: null, managed_by_org_id: null,
  member_role: null, member_status: null, org_user_id: null, org_name: null,
  password_set_at: null, user_id: 'me', ...o,
} as AccountKindRow);

describe('workspace manager routing', () => {
  it('an active manager of a WORKSPACE stays an individual (Messenger shell)', () => {
    const r = deriveAccountKind(baseRow({
      member_role: 'manager', member_status: 'active', org_user_id: 'ws-1',
      member_org_is_workspace: true, member_org_name: 'Acme',
    }), [{org_user_id: 'ws-1', member_role: 'manager', org_name: 'Acme', workspace_admin: false}]);
    expect(r.account_kind).toBe('individual');
    expect(r.workspaces).toEqual([{org_id: 'ws-1', name: 'Acme', role: 'manager'}]);
  });

  it('an active manager of an AGENCY is still an agency operator', () => {
    const r = deriveAccountKind(baseRow({
      member_role: 'manager', member_status: 'active', org_user_id: 'ag-1', member_org_is_workspace: false,
    }));
    expect(r.account_kind).toBe('agency');
  });

  it('a workspace Admin is reported as role manager + admin flag', () => {
    const r = deriveAccountKind(baseRow({}), [
      {org_user_id: 'ws-1', member_role: 'manager', org_name: 'Acme', workspace_admin: true},
    ]);
    expect(r.workspaces).toEqual([{org_id: 'ws-1', name: 'Acme', role: 'manager', admin: true}]);
  });

  it('the hub asks the AGENCY question, excluding workspace orgs', async () => {
    const db = {qOne: jest.fn().mockResolvedValue({yes: false})};
    await expect(resolveIsAgencyManager(db as never, 'u')).resolves.toBe(false);
    const sql = String(db.qOne.mock.calls[0][0]);
    expect(sql).toMatch(/NOT EXISTS\(SELECT 1 FROM public\.org_workspaces/);
    expect(sql).toMatch(/type = 'company'/);
  });
});

describe('workspace roles (User / Manager / Admin)', () => {
  const ORG = 'ws-owner';
  const db = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn()};
  const dept = {addMember: jest.fn(), addMemberBulk: jest.fn(), removeMember: jest.fn(),
    updateMemberRole: jest.fn(), placementGrantForMember: jest.fn()};
  let svc: OrgCpoService;

  beforeEach(async () => {
    jest.resetAllMocks();
    db.q.mockResolvedValue([]);
    dept.placementGrantForMember.mockResolvedValue(null);
    const mod = await Test.createTestingModule({providers: [
      OrgCpoService,
      {provide: DatabaseService, useValue: db},
      {provide: PasswordService, useValue: {}},
      {provide: DepartmentService, useValue: dept},
      {provide: AuthService, useValue: {revokeAllUserSessions: jest.fn()}},
      {provide: OrgAuditService, useValue: {log: jest.fn().mockResolvedValue(undefined)}},
    ]}).compile();
    svc = mod.get(OrgCpoService);
  });

  const target = (o: Record<string, unknown>) => ({status: 'active', org_is_workspace: true, ...o});

  it('a plain workspace MANAGER cannot change roles', async () => {
    db.qOne.mockResolvedValueOnce(target({member_role: 'employee', actor_is_admin: false}));
    await expect(svc.setMemberRole(ORG, 'emp', 'manager', 'mgr', null))
      .rejects.toThrow('only_owner_or_admin_can_change_roles');
  });

  it('the owner makes a User an Admin: manager row + admin flag + workspace grant', async () => {
    db.qOne
      .mockResolvedValueOnce(target({member_role: 'employee'}))
      .mockResolvedValueOnce({member_role: 'manager'})   // conditional UPDATE
      .mockResolvedValue({member_role: 'manager'});
    const r = await svc.setMemberRole(ORG, 'emp', 'admin', ORG);
    expect(r.member_role).toBe('admin');
    const upd = db.qOne.mock.calls.find(c => /UPDATE org_members SET member_role/.test(String(c[0])));
    expect(upd?.[1]).toEqual([ORG, 'emp', 'manager', 'employee', true, true, [...WORKSPACE_MANAGER_MODULES]]);
  });

  it('an Admin promotes a Manager to Admin (flag flip, no channel change)', async () => {
    db.qOne.mockResolvedValueOnce(target({member_role: 'manager', workspace_admin: false, actor_is_admin: true}));
    const r = await svc.setMemberRole(ORG, 'mgr', 'admin', 'adm', null);
    expect(r.member_role).toBe('admin');
    const flip = db.q.mock.calls.find(c => /SET workspace_admin = \$3/.test(String(c[0])));
    expect(flip?.[1]).toEqual([ORG, 'mgr', true, [...WORKSPACE_MANAGER_MODULES]]);
    expect(dept.addMember).not.toHaveBeenCalled();
  });

  it('an Admin cannot change ANOTHER Admin — owner only', async () => {
    db.qOne.mockResolvedValueOnce(target({member_role: 'manager', workspace_admin: true, actor_is_admin: true}));
    await expect(svc.setMemberRole(ORG, 'adm2', 'manager', 'adm', null))
      .rejects.toThrow('only_org_owner_can_change_admins');
  });

  it('an Admin may demote a non-admin Manager to User', async () => {
    db.qOne
      .mockResolvedValueOnce(target({member_role: 'manager', workspace_admin: false, actor_is_admin: true}))
      .mockResolvedValueOnce(null)                        // no managed-CPO agents row
      .mockResolvedValueOnce({member_role: 'employee'});  // conditional UPDATE
    const r = await svc.setMemberRole(ORG, 'mgr', 'employee', 'adm', null);
    expect(r.member_role).toBe('employee');
  });

  it('Admin is refused on an agency', async () => {
    db.qOne.mockResolvedValueOnce({member_role: 'cpo', status: 'active', org_is_workspace: false});
    await expect(svc.setMemberRole('agency', 'cpo', 'admin', 'agency'))
      .rejects.toThrow('role_change_not_allowed');
  });

  it('an Admin may suspend a Manager, but not another Admin', async () => {
    db.qOne.mockResolvedValueOnce({member_role: 'manager', workspace_admin: true, actor_is_admin: true});
    await expect(svc.setMemberStatus(ORG, 'adm2', 'removed', 'adm'))
      .rejects.toThrow('only_org_owner_can_change_admin_status');
    db.qOne.mockResolvedValueOnce({member_role: 'manager', workspace_admin: false, actor_is_admin: false});
    await expect(svc.setMemberStatus(ORG, 'mgr', 'removed', 'mgr2'))
      .rejects.toThrow('only_org_owner_can_change_manager_status');
  });
});

describe('OrgModuleGuard — workspace Admin', () => {
  const run = (required: string[], row: unknown) => {
    const db = {qOne: jest.fn().mockResolvedValue(row)};
    const reflector = {getAllAndOverride: jest.fn().mockReturnValue(required)} as unknown as Reflector;
    const guard = new OrgModuleGuard(reflector, db as unknown as DatabaseService);
    const ctx = {
      getHandler: () => ({}), getClass: () => ({}),
      switchToHttp: () => ({getRequest: () => ({orgManager: {user_id: 'adm', org_user_id: 'own', department: null}})}),
    } as unknown as ExecutionContext;
    return guard.canActivate(ctx);
  };
  it('an Admin passes owner-only routes and every module', async () => {
    await expect(run([ORG_OWNER_ONLY], {permitted_modules: [], workspace_admin: true})).resolves.toBe(true);
    await expect(run(['earn'], {permitted_modules: null, workspace_admin: true})).resolves.toBe(true);
  });
  it('a plain manager still cannot reach owner-only routes', async () => {
    await expect(run([ORG_OWNER_ONLY], {permitted_modules: ['dept'], workspace_admin: false}))
      .rejects.toThrow('org_owner_only');
  });
});
