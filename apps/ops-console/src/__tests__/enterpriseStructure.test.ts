import {
  buildStructureRows, canAddChildNode, placementPath, placementStateLabel, templateProblems, templatesForNewChild,
} from '../lib/enterpriseStructure';
import type {StructureChannel, StructureMember, StructureTemplates} from '../lib/api';

/** Enterprise structure editor (2026-10-15) — the founder's sample tree. */
function ch(id: string, parent: string | null, level: number, extra: Partial<StructureChannel> = {}): StructureChannel {
  return {id, name: id, parent_id: parent, level, is_lateral: false, is_broadcast: false, post_mode: 'open',
    access: 'standard', channel_type: 'department', archived: false, provisioned: false, member_count: 0,
    created_at: '2026-10-15T00:00:00Z', ...extra};
}
const lat = (id: string, parent: string, level: number, extra: Partial<StructureChannel> = {}) =>
  ch(id, parent, level, {is_lateral: true, ...extra});

const TREE: StructureChannel[] = [
  ch('GardaWorld Africa', null, 0),
  ch('South Africa', 'GardaWorld Africa', 1),
  ch('Kenya', 'GardaWorld Africa', 1),
  ch('Gauteng', 'South Africa', 2),
  ch('Johannesburg', 'Gauteng', 3),
  lat('Area Broadcast', 'Johannesburg', 3, {post_mode: 'announcement'}),
  lat('Provincial Broadcast', 'Gauteng', 2, {post_mode: 'announcement'}),
  lat('Old', 'Gauteng', 2, {archived: true}),
];
const member = (id: string, at: string | null, state: StructureMember['placement_state'] = at ? 'ok' : 'org'): StructureMember =>
  ({user_id: id, display_name: id, member_role: 'employee', department: null, placement_channel_id: at, placement_state: state});

describe('buildStructureRows', () => {
  it('lists a node, then its own channels, then its child nodes', () => {
    const rows = buildStructureRows(TREE);
    expect(rows.map(r => r.channel.id)).toEqual([
      'GardaWorld Africa', 'South Africa', 'Gauteng', 'Provincial Broadcast', 'Johannesburg', 'Area Broadcast', 'Kenya',
    ]);
    expect(rows.find(r => r.channel.id === 'Gauteng')).toEqual(expect.objectContaining({tier: 3, depth: 2, kind: 'node'}));
    expect(rows.find(r => r.channel.id === 'Area Broadcast')).toEqual(expect.objectContaining({tier: null, kind: 'lateral'}));
  });

  it('hides archived channels unless asked', () => {
    expect(buildStructureRows(TREE).some(r => r.channel.id === 'Old')).toBe(false);
    expect(buildStructureRows(TREE, [], {showArchived: true}).some(r => r.channel.id === 'Old')).toBe(true);
  });

  it('counts members placed AT each node', () => {
    const rows = buildStructureRows(TREE, [member('a', 'Johannesburg'), member('b', 'Johannesburg'), member('c', null)]);
    expect(rows.find(r => r.channel.id === 'Johannesburg')?.placed).toBe(2);
    expect(rows.find(r => r.channel.id === 'Gauteng')?.placed).toBe(0);
  });
});

describe('editor rules', () => {
  it('child nodes stop at the fourth level; channels never take children', () => {
    expect(canAddChildNode(ch('x', null, 2))).toBe(true);
    expect(canAddChildNode(ch('x', null, 3))).toBe(false);
    expect(canAddChildNode(lat('x', 'p', 1))).toBe(false);
    expect(canAddChildNode(ch('x', null, 1, {archived: true}))).toBe(false);
  });

  it('a new child gets the NEXT level\'s template; a new organisation gets level 0\'s', () => {
    const t: StructureTemplates = {'0': [{name: 'G', post_mode: 'announcement'}], '1': [], '2': [],
      '3': [{name: 'Operations', post_mode: 'open'}]};
    expect(templatesForNewChild(t, null).map(x => x.name)).toEqual(['G']);
    expect(templatesForNewChild(t, 2).map(x => x.name)).toEqual(['Operations']);
  });

  it('describes where a member sits, nearest first', () => {
    expect(placementPath(TREE, 'Johannesburg')).toBe('Johannesburg › Gauteng › South Africa › GardaWorld Africa');
    expect(placementPath(TREE, null)).toBe('Whole organisation');
    expect(placementStateLabel(member('x', 'gone', 'missing'))).toMatch(/broadcasts only/);
    expect(placementStateLabel(member('x', 'Johannesburg'))).toBeNull();
  });

  it('flags template mistakes before they are sent', () => {
    const ok: StructureTemplates = {'0': [], '1': [], '2': [], '3': [{name: 'Ops', post_mode: 'open'}]};
    expect(templateProblems(ok)).toBeNull();
    expect(templateProblems({...ok, '3': [{name: ' ', post_mode: 'open'}]})).toMatch(/needs a name/);
    expect(templateProblems({...ok, '3': [{name: 'Ops', post_mode: 'open'}, {name: 'ops', post_mode: 'open'}]})).toMatch(/twice/);
  });
});
