import {BadRequestException} from '@nestjs/common';
import {DepartmentService} from './department.service';
import type {PlacementRow} from './placement';

/**
 * Enterprise structure (2026-10-15) — the SEEDERS honour placement.
 *
 * placement.spec.ts pins the graph rule. This file pins that the two writers
 * that matter use it: createChannel (a new channel reaches only the people it
 * is for) and applyPlacement (moving someone reconciles their memberships
 * through addMemberBulk / removeMember, the rekey-intent writers).
 *
 * The fake database routes by SQL text and keeps the channel list as state,
 * so a channel created in a test is visible to the placement walk that runs
 * right after its INSERT — the order the real service depends on.
 */
const ORG = 'org-1';

function n(id: string, parent: string | null, extra: Partial<PlacementRow> = {}): PlacementRow {
  return {id, parent_id: parent, is_lateral: false, is_broadcast: false, post_mode: 'open',
    access: 'standard', channel_type: 'department', archived: false, ...extra};
}

function world() {
  const channels: Array<PlacementRow & {level: number}> = [
    {...n('gw', null), level: 0},
    {...n('za', 'gw'), level: 1},
    {...n('gp', 'za'), level: 2},
    {...n('jhb', 'gp'), level: 3},
    {...n('tsh', 'gp'), level: 3},
    {...n('tsh-ops', 'tsh', {is_lateral: true}), level: 3},
    {...n('gp-com', 'gp', {is_lateral: true}), level: 2},
  ];
  const members = [
    {member_user_id: 'u-jhb', member_role: 'employee', placement_channel_id: 'jhb'},
    {member_user_id: 'u-tsh', member_role: 'employee', placement_channel_id: 'tsh'},
    {member_user_id: 'u-gp', member_role: 'employee', placement_channel_id: 'gp'},
    {member_user_id: 'u-all', member_role: 'employee', placement_channel_id: null},
    {member_user_id: 'u-mgr', member_role: 'manager', placement_channel_id: 'tsh'},
  ];
  const seeded: Array<{channel: string; users: string[]; roles: string[]}> = [];
  const memberships = new Map<string, Array<{channel_id: string; role: 'admin' | 'viewer'}>>();
  const updates: Array<{sql: string; params: unknown[]}> = [];

  const q = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (/SELECT member_user_id, member_role, placement_channel_id FROM public\.org_members/.test(sql)) {
      return members;
    }
    if (/SELECT id, parent_id, is_lateral, is_broadcast, post_mode, access, channel_type/.test(sql)) {
      return channels.map(({level: _l, ...r}) => r);
    }
    if (/INSERT INTO public\.department_channel_members \(channel_id, user_id, role, role_label\)\s+SELECT \$1/.test(sql)) {
      seeded.push({channel: params[0] as string, users: params[1] as string[], roles: params[2] as string[]});
      return [];
    }
    if (/FROM public\.department_channel_members m\s+JOIN public\.department_channels c/.test(sql)) {
      return memberships.get(params[1] as string) ?? [];
    }
    if (/^\s*UPDATE/.test(sql)) {updates.push({sql, params}); return [];}
    return [];
  });
  const qOne = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (/SELECT org_id, level, is_broadcast, is_lateral, parent_id, access, channel_type/.test(sql)) {
      const p = channels.find(c => c.id === params[0]);
      return p ? {org_id: ORG, level: p.level, is_broadcast: p.is_broadcast, is_lateral: p.is_lateral,
        parent_id: p.parent_id, access: p.access, channel_type: p.channel_type} : null;
    }
    if (/INSERT INTO public\.department_channels/.test(sql)) {
      const parent = channels.find(c => c.id === params[6]);
      const lateral = params[8] === true;
      const row = {...n(`new-${channels.length}`, (params[6] as string) ?? null,
        {is_lateral: lateral, post_mode: params[7] as PlacementRow['post_mode']}),
      level: parent ? parent.level + (lateral ? 0 : 1) : 0};
      channels.push(row);
      return {id: row.id, level: row.level, is_lateral: lateral};
    }
    if (/SELECT member_role FROM public\.org_members/.test(sql)) {
      const m = members.find(x => x.member_user_id === params[1]);
      return m ? {member_role: m.member_role} : null;
    }
    return null;
  });
  const tx = {q: jest.fn(async (sql: string, params: unknown[] = []) => {
    updates.push({sql, params}); return [];
  }), qOne: jest.fn()};
  const db = {q, qOne, withTransaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx))};
  const audit = {log: jest.fn()};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new DepartmentService(db as any, audit as any);
  return {svc, seeded, memberships, updates, audit, channels};
}

describe('createChannel seeds by placement', () => {
  it('a channel in Johannesburg reaches Johannesburg, the province and the unplaced — not Tshwane', async () => {
    const w = world();
    const ch = await w.svc.createChannel(ORG, ORG, {name: 'Night shift', parent_id: 'jhb', lateral: true, post_mode: 'open'});
    const s = w.seeded.find(x => x.channel === ch.id)!;
    expect(s.users.sort()).toEqual(['u-all', 'u-gp', 'u-jhb']);
    expect(s.users).not.toContain('u-tsh');
    expect(s.users).not.toContain('u-mgr');
  });

  it('a province announcement reaches the areas below READ-ONLY', async () => {
    const w = world();
    const ch = await w.svc.createChannel(ORG, ORG, {name: 'Announcements', parent_id: 'gp', lateral: true, post_mode: 'announcement'});
    const s = w.seeded.find(x => x.channel === ch.id)!;
    const roleOf = (u: string) => s.roles[s.users.indexOf(u)];
    expect(s.users).toEqual(expect.arrayContaining(['u-jhb', 'u-tsh', 'u-gp', 'u-all', 'u-mgr']));
    // The Tshwane manager only READS a province channel above their area.
    expect(roleOf('u-mgr')).toBe('viewer');
    expect(roleOf('u-jhb')).toBe('viewer');
  });

  it('an OPEN province chat is not pushed into the areas', async () => {
    const w = world();
    const ch = await w.svc.createChannel(ORG, ORG, {name: 'Committees 2', parent_id: 'gp', lateral: true, post_mode: 'open'});
    const s = w.seeded.find(x => x.channel === ch.id)!;
    expect(s.users.sort()).toEqual(['u-all', 'u-gp']);
  });

  it('names the console admin in the org audit row when one is given', async () => {
    const w = world();
    await w.svc.createChannel(ORG, ORG, {name: 'X', parent_id: 'jhb', lateral: true}, 'ops-admin-1');
    expect(w.audit.log).toHaveBeenCalledWith(ORG, 'ops-admin-1', 'channel.create', expect.anything());
  });
});

describe('applyPlacement', () => {
  it('moving Tshwane → Johannesburg removes Tshwane, adds Johannesburg, demotes readers that post', async () => {
    const w = world();
    w.memberships.set('u-tsh', [
      {channel_id: 'tsh', role: 'admin'},
      {channel_id: 'tsh-ops', role: 'admin'},
      {channel_id: 'gp', role: 'admin'},     // province chat, reader after the move → demote
      {channel_id: 'gp-com', role: 'admin'}, // open province chat, out of scope → remove
    ]);
    const add = jest.spyOn(w.svc, 'addMemberBulk').mockResolvedValue({added: 1, skipped: 0});
    const remove = jest.spyOn(w.svc, 'removeMember').mockResolvedValue({ok: true});

    const out = await w.svc.applyPlacement(ORG, 'u-tsh', 'jhb', 'ops-admin-1');

    expect(add).toHaveBeenCalledWith(ORG, 'u-tsh',
      expect.arrayContaining([
        expect.objectContaining({channelId: 'jhb', role: 'admin'}),
        expect.objectContaining({channelId: 'za', role: 'viewer'}),
        expect.objectContaining({channelId: 'gw', role: 'viewer'}),
      ]), 'ops-admin-1');
    const removed = remove.mock.calls.map(c => c[1]).sort();
    expect(removed).toEqual(['gp-com', 'tsh', 'tsh-ops']);
    const demote = w.updates.find(u => /SET role = 'viewer'/.test(u.sql));
    expect(demote?.params[1]).toEqual(['gp']);
    expect(w.updates.some(u => /SET placement_channel_id = \$3/.test(u.sql) && u.params[2] === 'jhb')).toBe(true);
    expect(out).toEqual(expect.objectContaining({placement_channel_id: 'jhb', removed: 3}));
  });

  it('back to the whole organisation removes nothing', async () => {
    const w = world();
    w.memberships.set('u-jhb', [{channel_id: 'jhb', role: 'admin'}]);
    jest.spyOn(w.svc, 'addMemberBulk').mockResolvedValue({added: 0, skipped: 0});
    const remove = jest.spyOn(w.svc, 'removeMember').mockResolvedValue({ok: true});
    await w.svc.applyPlacement(ORG, 'u-jhb', null, 'ops-admin-1');
    expect(remove).not.toHaveBeenCalled();
  });

  it('refuses a lateral or an unknown node', async () => {
    const w = world();
    await expect(w.svc.applyPlacement(ORG, 'u-jhb', 'tsh-ops', 'a')).rejects.toThrow(BadRequestException);
    await expect(w.svc.applyPlacement(ORG, 'u-jhb', 'nope', 'a')).rejects.toThrow(BadRequestException);
  });
});

describe('2026-10-27 — channel members chosen at creation', () => {
  it('seeds only the chosen people (plus managers), and marks the channel explicit', async () => {
    const w = world();
    const ch = await w.svc.createChannel(ORG, ORG, {name: 'Board', member_ids: ['u-tsh', 'u-all', 'not-a-member']});
    const s = w.seeded.find(x => x.channel === ch.id)!;
    // Placement does not override a hand-picked list; strangers are ignored.
    expect(s.users.sort()).toEqual(['u-all', 'u-mgr', 'u-tsh']);
    expect(s.users).not.toContain('not-a-member');
    expect(w.audit.log).toHaveBeenCalledWith(ORG, ORG, 'channel.create',
      expect.objectContaining({metadata: expect.objectContaining({explicit_members: 3})}));
  });

  it('without member_ids nothing changes (every eligible member)', async () => {
    const w = world();
    const ch = await w.svc.createChannel(ORG, ORG, {name: 'All hands'});
    const s = w.seeded.find(x => x.channel === ch.id)!;
    expect(s.users).toContain('u-all');
    expect(w.audit.log).toHaveBeenCalledWith(ORG, ORG, 'channel.create',
      expect.objectContaining({metadata: expect.not.objectContaining({explicit_members: expect.anything()})}));
  });
});
