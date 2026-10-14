import {isOneWay, placementGrant, type PlacementRow} from './placement';
import {DepartmentService} from './department.service';

/**
 * Enterprise structure (2026-10-15) — the founder's sample tree:
 *
 *   GardaWorld Africa (L1)
 *   ├─ South Africa (L2)
 *   │  └─ Gauteng Province (L3)  + Provincial Broadcast, Committees, Announcements, Knowledge Hub
 *   │     ├─ Johannesburg Area (L4) + Area Broadcast, Operations, Logistics
 *   │     └─ Tshwane Area (L4)      + Area Broadcast, Operations
 *   └─ Kenya (L2)
 */
function n(id: string, parent: string | null, extra: Partial<PlacementRow> = {}): PlacementRow {
  return {id, parent_id: parent, is_lateral: false, is_broadcast: false, post_mode: 'open',
    access: 'standard', channel_type: 'department', ...extra};
}
const lat = (id: string, parent: string, post_mode: PlacementRow['post_mode'], extra: Partial<PlacementRow> = {}) =>
  n(id, parent, {is_lateral: true, post_mode, ...extra});

const TREE: PlacementRow[] = [
  n('gw', null),
  n('za', 'gw'),
  n('ke', 'gw'),
  n('gp', 'za'),
  lat('gp-bc', 'gp', 'announcement'),
  lat('gp-com', 'gp', 'open'),
  lat('gp-ann', 'gp', 'announcement'),
  lat('gp-kh', 'gp', 'read_only'),
  n('jhb', 'gp'),
  lat('jhb-bc', 'jhb', 'announcement'),
  lat('jhb-ops', 'jhb', 'open'),
  lat('jhb-log', 'jhb', 'open'),
  n('tsh', 'gp'),
  lat('tsh-bc', 'tsh', 'announcement'),
  lat('tsh-ops', 'tsh', 'open'),
];

const rule = DepartmentService.seedsManagersOnly;
const grantOf = (rows: PlacementRow[], at: string | null, mgr = false) => placementGrant(rows, at, mgr, rule);

describe('placementGrant — "their node and everything below, plus the parents\' broadcasts"', () => {
  it('unplaced is org-wide (null), i.e. exactly the pre-placement behaviour', () => {
    expect(grantOf(TREE, null)).toBeNull();
  });

  it('an area member gets their area and its channels as a MEMBER', () => {
    const g = grantOf(TREE, 'jhb')!;
    for (const id of ['jhb', 'jhb-bc', 'jhb-ops', 'jhb-log']) {expect(`${id}:${g.get(id)}`).toBe(`${id}:member`);}
  });

  it('…the levels above READ-ONLY, so the tree reads as a path, not "(not shown)"', () => {
    const g = grantOf(TREE, 'jhb')!;
    for (const id of ['gp', 'za', 'gw']) {expect(`${id}:${g.get(id)}`).toBe(`${id}:reader`);}
  });

  it('…the province\'s ONE-WAY channels read-only, but never its open committee chat', () => {
    const g = grantOf(TREE, 'jhb')!;
    expect(g.get('gp-bc')).toBe('reader');
    expect(g.get('gp-ann')).toBe('reader');
    expect(g.get('gp-kh')).toBe('reader');
    expect(g.has('gp-com')).toBe(false);
  });

  it('…and nothing from a sibling area or another country', () => {
    const g = grantOf(TREE, 'jhb')!;
    for (const id of ['tsh', 'tsh-bc', 'tsh-ops', 'ke']) {expect(`${id}:${g.has(id)}`).toBe(`${id}:false`);}
  });

  it('a province member is a member of the whole province subtree', () => {
    const g = grantOf(TREE, 'gp')!;
    for (const id of ['gp', 'gp-com', 'jhb', 'jhb-ops', 'tsh', 'tsh-ops']) {
      expect(`${id}:${g.get(id)}`).toBe(`${id}:member`);
    }
    expect(g.get('za')).toBe('reader');
    expect(g.has('ke')).toBe(false);
  });

  it('the organisation\'s #broadcast reaches everyone, read-only', () => {
    const rows = [...TREE, n('bc1', 'ke', {is_broadcast: true, post_mode: 'announcement'})];
    expect(grantOf(rows, 'jhb')!.get('bc1')).toBe('reader');
  });

  it('archived channels are never granted, but the walk climbs through them', () => {
    const rows = TREE.map(r => (r.id === 'za' ? {...r, archived: true} : r))
      .concat(lat('jhb-old', 'jhb', 'open', {archived: true}));
    const g = grantOf(rows, 'jhb')!;
    expect(g.has('za')).toBe(false);
    expect(g.get('gw')).toBe('reader');
    expect(g.has('jhb-old')).toBe(false);
  });

  it('managers-only channels follow the visibility rule: managers yes, others no', () => {
    const rows = [...TREE, lat('jhb-mgr', 'jhb', 'open', {access: 'restricted'})];
    expect(grantOf(rows, 'jhb', false)!.has('jhb-mgr')).toBe(false);
    expect(grantOf(rows, 'jhb', true)!.get('jhb-mgr')).toBe('member');
  });

  it('FAILS CLOSED when the placement node no longer exists: broadcasts only', () => {
    const rows = [...TREE, n('bc1', 'gw', {is_broadcast: true, post_mode: 'announcement'})];
    const g = grantOf(rows, 'deleted-node')!;
    expect([...g.keys()]).toEqual(['bc1']);
  });

  it('member wins over reader for the same row', () => {
    // A #broadcast that is a lateral of the member's own node.
    const rows = [...TREE, n('jbc', 'jhb', {is_broadcast: true, is_lateral: true, post_mode: 'announcement'})];
    expect(grantOf(rows, 'jhb')!.get('jbc')).toBe('member');
  });
});

describe('isOneWay', () => {
  it('announcement, read-only and #broadcast flow down; open and admin-only do not', () => {
    expect(isOneWay({is_broadcast: false, post_mode: 'announcement'})).toBe(true);
    expect(isOneWay({is_broadcast: false, post_mode: 'read_only'})).toBe(true);
    expect(isOneWay({is_broadcast: true, post_mode: 'open'})).toBe(true);
    expect(isOneWay({is_broadcast: false, post_mode: 'open'})).toBe(false);
    expect(isOneWay({is_broadcast: false, post_mode: 'admin_only'})).toBe(false);
  });
});
