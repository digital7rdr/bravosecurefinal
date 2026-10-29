/**
 * 2026-10-30 (owner: "make them admin in the group like WhatsApp") — group
 * admins are granted / withdrawn by a `rename` admin action that keeps the
 * name and carries `admins`, so phones that predate it stay in epoch step.
 */
import {applyAdminAction, makeNewGroup} from '../src/groups/groupClient';
import type {GroupState} from '../src/groups/types';

const group = (): GroupState => makeNewGroup({
  name: 'Ops', owner: 'own', ownerDeviceId: 1,
  members: [{userId: 'a', deviceId: 1}, {userId: 'b', deviceId: 1}],
});

describe('group admins', () => {
  it('an admin makes a member an admin; epoch advances like any rename', () => {
    const g = group();
    const next = applyAdminAction(g, {type: 'rename', name: g.name, atEpoch: g.epoch, admins: [{userId: 'a', admin: true}]}, 'own');
    expect(next.members.a.admin).toBe(true);
    expect(next.members.b.admin).toBe(false);
    expect(next.epoch).toBe(g.epoch + 1);
    expect(next.name).toBe('Ops');
  });

  it('the new admin can then act; a plain member cannot', () => {
    const g = applyAdminAction(group(), {type: 'rename', name: 'Ops', atEpoch: 0, admins: [{userId: 'a', admin: true}]}, 'own');
    const byA = applyAdminAction(g, {type: 'rename', name: 'Ops', atEpoch: g.epoch, admins: [{userId: 'b', admin: true}]}, 'a');
    expect(byA.members.b.admin).toBe(true);
    const byB = applyAdminAction(group(), {type: 'rename', name: 'Ops', atEpoch: 0, admins: [{userId: 'b', admin: true}]}, 'b');
    expect(byB.members.b.admin).toBe(false);
  });

  it('the creator can never be dismissed; strangers and junk are ignored', () => {
    const g = applyAdminAction(group(), {type: 'rename', name: 'Ops', atEpoch: 0, admins: [{userId: 'a', admin: true}]}, 'own');
    const next = applyAdminAction(g, {type: 'rename', name: 'Ops', atEpoch: g.epoch, admins: [
      {userId: 'own', admin: false}, {userId: 'zz', admin: true},
      {userId: 'b', admin: 'yes' as unknown as boolean},
    ]}, 'a');
    expect(next.members.own.admin).toBe(true);
    expect(next.members.zz).toBeUndefined();
    expect(next.members.b.admin).toBe(false);
  });

  it('dismissing an admin works and a plain rename leaves admins alone', () => {
    let g = applyAdminAction(group(), {type: 'rename', name: 'Ops', atEpoch: 0, admins: [{userId: 'a', admin: true}]}, 'own');
    g = applyAdminAction(g, {type: 'rename', name: 'Ops 2', atEpoch: g.epoch}, 'own');
    expect(g.members.a.admin).toBe(true);
    g = applyAdminAction(g, {type: 'rename', name: 'Ops 2', atEpoch: g.epoch, admins: [{userId: 'a', admin: false}]}, 'own');
    expect(g.members.a.admin).toBe(false);
  });

  it('a stale epoch changes nothing', () => {
    const g = group();
    expect(applyAdminAction(g, {type: 'rename', name: 'Ops', atEpoch: g.epoch + 5, admins: [{userId: 'a', admin: true}]}, 'own')).toBe(g);
  });
});
