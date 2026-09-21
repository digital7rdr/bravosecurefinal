/**
 * The organisation graph — pins for the rule that draws an org's channel tree.
 *
 * The rule mirrors the mobile app's organisationTree.ts (tier = walk depth,
 * laterals don't take a tier, level names from workspace settings). These
 * tests are what keep the console's drawing from drifting away from what the
 * app shows its own admins.
 */
import {
  buildOrgGraph, nameForTier, edgePath, isLateral,
  DEFAULT_LEVEL_NAMES, NODE_W, H_GAP, ORG_NODE_ID, type GraphChannel,
} from '../lib/orgGraph';

const ch = (id: string, parent: string | null, extra: Partial<GraphChannel> = {}): GraphChannel =>
  ({id, name: id, parent_id: parent, level: 1, ...extra});

describe('nameForTier — the level vocabulary', () => {
  it('falls back to the built-ins and clamps out-of-range tiers', () => {
    expect(nameForTier(1)).toBe('Enterprise');
    expect(nameForTier(4)).toBe('Sub-sub');
    expect(nameForTier(0)).toBe('Enterprise');
    expect(nameForTier(9)).toBe('Sub-sub');
    expect(DEFAULT_LEVEL_NAMES).toHaveLength(4);
  });

  it('a short or blank admin choice fills from the defaults per tier', () => {
    expect(nameForTier(1, ['Region'])).toBe('Region');
    expect(nameForTier(2, ['Region'])).toBe('Main');
    expect(nameForTier(2, ['Region', '  '])).toBe('Main');
    expect(nameForTier(3, ['', '', 'Unit'])).toBe('Unit');
  });
});

describe('buildOrgGraph — totality', () => {
  it('draws every channel exactly once, plus the organisation node', () => {
    const rows = [
      ch('hq', null, {level: 0}),
      ch('ops', 'hq'), ch('intel', 'hq'),
      ch('ops-a', 'ops'), ch('ops-b', 'ops'),
      ch('chat', 'ops', {is_lateral: true}),
      ch('bcast', 'hq', {is_broadcast: true}),
    ];
    const g = buildOrgGraph(rows, {orgName: 'Acme'});
    expect(g.nodes).toHaveLength(rows.length + 1);
    expect(new Set(g.nodes.map(n => n.id)).size).toBe(rows.length + 1);
    expect(g.edges).toHaveLength(rows.length);
    expect(g.nodes[0].id).toBe(ORG_NODE_ID);
    expect(g.nodes[0].kind).toBe('org');
  });

  it('a child whose parent is not in the list hangs off the organisation, not nowhere', () => {
    const g = buildOrgGraph([ch('orphan', 'archived-parent')], {orgName: 'Acme'});
    const n = g.nodes.find(x => x.id === 'orphan')!;
    expect(n.parentId).toBe(ORG_NODE_ID);
    expect(n.tier).toBe(1);
  });

  it('rows reachable only through a cycle are still drawn (swept under the org)', () => {
    const g = buildOrgGraph([ch('a', 'b'), ch('b', 'a'), ch('root', null)], {orgName: 'Acme'});
    expect(g.nodes.map(n => n.id).sort()).toEqual([ORG_NODE_ID, 'a', 'b', 'root'].sort());
    // A self-parented row is treated as a root, never as its own child.
    const self = buildOrgGraph([ch('me', 'me')], {orgName: 'Acme'});
    expect(self.nodes.find(n => n.id === 'me')!.parentId).toBe(ORG_NODE_ID);
  });
});

describe('buildOrgGraph — tier is walk depth, laterals take none', () => {
  it('a legacy level-1 root and a level-0 root are both tier 1', () => {
    const g = buildOrgGraph([ch('legacy', null, {level: 1}), ch('fresh', null, {level: 0})], {orgName: 'Acme'});
    for (const id of ['legacy', 'fresh']) {
      const n = g.nodes.find(x => x.id === id)!;
      expect(n.tier).toBe(1);
      expect(n.tierLabel).toBe('Enterprise');
    }
  });

  it('a lateral keeps its parent tier; a structural child advances it; tiers clamp at 4', () => {
    const rows = [
      ch('t1', null), ch('t2', 't1'), ch('t3', 't2'), ch('t4', 't3'), ch('t5', 't4'),
      ch('lat', 't2', {is_lateral: true}), ch('lat-kid', 'lat'),
      ch('ann', 't1', {is_broadcast: true}),
    ];
    const g = buildOrgGraph(rows, {orgName: 'Acme', levelNames: ['Region', 'Site']});
    const at = (id: string) => g.nodes.find(x => x.id === id)!;
    expect(at('t1').tierLabel).toBe('Region');
    expect(at('t2').tierLabel).toBe('Site');
    expect(at('t3').tierLabel).toBe('Sub');
    expect(at('t4').tierLabel).toBe('Sub-sub');
    expect(at('t5').tier).toBe(4);
    expect(at('lat').kind).toBe('lateral');
    expect(at('lat').tier).toBeNull();
    expect(at('lat').tierLabel).toBe('Lateral');
    expect(at('lat-kid').tier).toBe(3);
    expect(at('ann').tierLabel).toBe('Announcement');
    expect(isLateral({is_broadcast: true})).toBe(true);
    expect(g.edges.find(e => e.to === 'lat')!.lateral).toBe(true);
    expect(g.edges.find(e => e.to === 't2')!.lateral).toBe(false);
  });

  it('orders siblings levels-first then alphabetically, so the list and the graph agree', () => {
    const rows = [ch('zeta', null), ch('alpha', null), ch('chat', null, {is_lateral: true}), ch('beta', null)];
    const g = buildOrgGraph(rows, {orgName: 'Acme'});
    expect(g.nodes.slice(1).map(n => n.id)).toEqual(['alpha', 'beta', 'zeta', 'chat']);
  });
});

describe('buildOrgGraph — layout', () => {
  it('no two nodes on one row overlap, and the canvas contains every node', () => {
    const rows: GraphChannel[] = [ch('hq', null)];
    for (let i = 0; i < 6; i++) {
      rows.push(ch(`d${i}`, 'hq'));
      for (let j = 0; j < 3; j++) rows.push(ch(`d${i}-t${j}`, `d${i}`));
    }
    const g = buildOrgGraph(rows, {orgName: 'Acme'});
    const byDepth = new Map<number, number[]>();
    for (const n of g.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w).toBeLessThanOrEqual(g.width);
      expect(n.y + n.h).toBeLessThanOrEqual(g.height);
      byDepth.set(n.depth, [...(byDepth.get(n.depth) ?? []), n.x]);
    }
    for (const xs of byDepth.values()) {
      xs.sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(NODE_W + H_GAP - 1e-6);
    }
    // A parent sits centred over its children.
    const hq = g.nodes.find(n => n.id === 'hq')!;
    const kids = g.nodes.filter(n => n.parentId === 'hq');
    const left = Math.min(...kids.map(k => k.x)), right = Math.max(...kids.map(k => k.x + k.w));
    expect(Math.abs((hq.x + hq.w / 2) - (left + right) / 2)).toBeLessThan(1e-6);
  });

  it('an empty organisation still draws the organisation node alone', () => {
    const g = buildOrgGraph([], {orgName: 'Acme'});
    expect(g.nodes).toHaveLength(1);
    expect(g.edges).toHaveLength(0);
    expect(g.width).toBeGreaterThan(NODE_W);
  });

  it('edgePath runs from the parent bottom-centre to the child top-centre', () => {
    const g = buildOrgGraph([ch('a', null)], {orgName: 'Acme'});
    const [org, a] = g.nodes;
    const d = edgePath(org, a);
    expect(d.startsWith(`M ${org.x + org.w / 2} ${org.y + org.h}`)).toBe(true);
    expect(d.endsWith(`V ${a.y}`)).toBe(true);
  });
});
