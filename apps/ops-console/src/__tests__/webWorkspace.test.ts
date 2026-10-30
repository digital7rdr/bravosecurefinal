/**
 * 2026-10-27/28 — the Workspace page of the Bravo Web App: members, roles
 * (User / Manager / Admin), status, and channels with chosen members, for the
 * owner, Admins and Managers of a workspace.
 */
import fs from 'fs';
import path from 'path';
import {managedWorkspaces, type WebMe} from '../lib/web/access';
import {WEB_NAV, webNavFor} from '../lib/web/nav';
import {canChangeRole, canChangeStatus, roleOf, workspaceErrorText} from '../lib/web/workspace';
import {workspaceApi, type WsMember} from '../lib/web/api';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const me = (workspaces: WebMe['workspaces']): WebMe => ({
  user: {id: 'u', email: null, display_name: 'A', role: 'individual', phone_e164: null, avatar_url: null},
  account_kind: 'individual', must_set_password: false, is_org_manager: true, auto_dispatch_enabled: false, workspaces,
});
const member = (o: Partial<WsMember>): WsMember => ({
  member_user_id: 'm', display_name: 'M', email: null, member_role: 'employee', status: 'active',
  suspended_until: null, suspend_reason: null, ...o,
});

describe('who sees the Workspace page', () => {
  it('owners, Admins and Managers — not plain members', () => {
    expect(managedWorkspaces(me([
      {org_id: 'a', name: 'Acme', role: 'owner'},
      {org_id: 'b', name: 'Borealis', role: 'manager', admin: true},
      {org_id: 'c', name: 'Cobalt', role: 'manager'},
      {org_id: 'd', name: 'Delta', role: 'employee'},
    ])).map(w => [w.org_id, w.level])).toEqual([['a', 'owner'], ['b', 'admin'], ['c', 'manager']]);
  });

  it('the rail adds Workspace before Account only for them', () => {
    expect(webNavFor(me([{org_id: 'd', name: 'D', role: 'employee'}]))).toEqual(WEB_NAV);
    expect(webNavFor(me([{org_id: 'a', name: 'A', role: 'owner'}])).map(i => i.label))
      .toEqual(['Chats', 'Contacts', 'Groups', 'Workspace', 'Account']);
    expect(read('components/web/WebShell.tsx')).toMatch(/const nav = webRailFor\(me, section\);/);
    expect(read('lib/web/nav.ts')).toMatch(/section === 'services' \? WEB_SERVICES_NAV : webNavFor\(me\)/);
  });
});

describe('what each level may change (mirrors the server)', () => {
  const user = member({});
  const mgr = member({member_role: 'manager'});
  const admin = member({member_role: 'manager', workspace_admin: true});

  it('roles: owner everyone; Admin all but Admins; Manager nobody', () => {
    expect(roleOf(admin)).toBe('admin');
    expect([user, mgr, admin].map(m => canChangeRole('owner', m))).toEqual([true, true, true]);
    expect([user, mgr, admin].map(m => canChangeRole('admin', m))).toEqual([true, true, false]);
    expect([user, mgr, admin].map(m => canChangeRole('manager', m))).toEqual([false, false, false]);
    expect(canChangeRole('owner', member({status: 'suspended'}))).toBe(false);
  });

  it('status: Users by any manager; Managers by owner/Admin; Admins by the owner only', () => {
    expect([user, mgr, admin].map(m => canChangeStatus('manager', m))).toEqual([true, false, false]);
    expect([user, mgr, admin].map(m => canChangeStatus('admin', m))).toEqual([true, true, false]);
    expect([user, mgr, admin].map(m => canChangeStatus('owner', m))).toEqual([true, true, true]);
  });

  it('server refusals read as sentences', () => {
    expect(workspaceErrorText({body: {message: 'only_org_owner_can_change_admins'}})).toMatch(/Only the workspace owner/);
    expect(workspaceErrorText({body: {message: 'org_module_not_granted:roster|dept'}})).toMatch(/Ask the workspace owner/);
  });
});

describe('every workspace call names the workspace', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('X-Org-Context on reads and writes; channel members go in member_ids', async () => {
    const calls: Array<{url: string; init: RequestInit}> = [];
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({url, init});
      return new Response(JSON.stringify({ok: true, channels: []}), {status: 200});
    }) as unknown as typeof fetch;
    const api = workspaceApi('org-9');
    await api.members();
    await api.setRole('u1', 'admin');
    await api.createChannel({name: 'Board', access: 'standard', post_mode: 'open', member_ids: ['u1']});
    for (const c of calls) expect((c.init.headers as Record<string, string>)['X-Org-Context']).toBe('org-9');
    expect(calls[1].url).toMatch(/\/org\/cpos\/u1\/role$/);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({member_role: 'admin'});
    expect(JSON.parse(String(calls[2].init.body))).toMatchObject({name: 'Board', member_ids: ['u1']});
  });
});

describe('the page file', () => {
  it('exports only its component (Next.js refuses other page exports)', () => {
    const src = read('app/web/(app)/workspace/page.tsx');
    expect(src.match(/^export /gm)).toEqual(['export ']);
    expect(src).toMatch(/export default function WebWorkspace/);
  });
});
