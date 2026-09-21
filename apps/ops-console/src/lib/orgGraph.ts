/**
 * The organisation graph — the ONE rule that turns an organisation's flat
 * channel list into a drawn tree for the console detail page (and the ordered,
 * indented channel list above it).
 *
 * Tier semantics mirror the mobile app's `organisationTree.ts`, on purpose:
 *
 *  - TIER IS WALK DEPTH, not the stored `level` column. Legacy workspaces root
 *    at level 1 and "+ Create new organisation" mints roots at level 0, so the
 *    same visual tier has two stored values. Labelling by `level` would show two
 *    identical organisations as L1 and L2.
 *  - A LATERAL (`is_lateral`, or a `#broadcast`) hangs off its parent WITHOUT
 *    taking a tier of its own — "part of the same level, just nested under it".
 *  - The vocabulary is the app's DEFAULT_LEVEL_NAMES, overridden per org by
 *    `org_workspace_settings.level_names` (short / sparse arrays fill from the
 *    defaults; a blank entry means "default", not "unnamed").
 *
 * The console cannot import mobile source, so the rule is MIRRORED here rather
 * than re-invented; `orgGraph.test.ts` pins the shared behaviour.
 *
 * Totality: every input row appears EXACTLY ONCE. A row whose parent is not in
 * the list (archived, or outside the org) hangs off the organisation node
 * instead of vanishing; rows only reachable through a cycle are swept in the
 * same way. A graph that silently drops a channel is worse than one that draws
 * it in the wrong place.
 */

export const DEFAULT_LEVEL_NAMES = ['Enterprise', 'Main', 'Sub', 'Sub-sub'] as const;
export const MAX_TIER = DEFAULT_LEVEL_NAMES.length;

export function nameForTier(tier: number, chosen?: readonly string[] | null): string {
  const clamped = Math.min(Math.max(Math.trunc(tier) || 1, 1), MAX_TIER);
  const picked = chosen?.[clamped - 1]?.trim();
  return picked && picked.length > 0 ? picked : DEFAULT_LEVEL_NAMES[clamped - 1];
}

export interface GraphChannel {
  id: string;
  name: string;
  parent_id: string | null;
  level?: number;
  is_broadcast?: boolean;
  is_lateral?: boolean;
  channel_type?: string;
  access?: string;
  post_mode?: string;
  department?: string | null;
  member_count?: number;
  provisioned?: boolean;
}

export type GraphNodeKind = 'org' | 'level' | 'lateral';

export interface GraphNode {
  id: string;
  name: string;
  kind: GraphNodeKind;
  /** Display tier 1..4 for a level row; null for the org node and laterals. */
  tier: number | null;
  /** What this row is called on screen: a tier name, "Lateral", "Announcement". */
  tierLabel: string;
  /** Indent steps from the organisation node (0). */
  depth: number;
  parentId: string | null;
  childCount: number;
  x: number;
  y: number;
  w: number;
  h: number;
  channel: GraphChannel | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  lateral: boolean;
}

export interface OrgGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

export const NODE_W = 172;
export const NODE_H = 58;
export const H_GAP = 18;
export const V_GAP = 54;
export const PAD = 16;

/** The synthetic organisation node's id — never a channel uuid. */
export const ORG_NODE_ID = '__org__';

export function isLateral(c: Pick<GraphChannel, 'is_lateral' | 'is_broadcast'>): boolean {
  return c.is_lateral === true || c.is_broadcast === true;
}

export function buildOrgGraph(
  channels: readonly GraphChannel[],
  opts: {orgName: string; levelNames?: readonly string[] | null},
): OrgGraph {
  const present = new Map<string, GraphChannel>();
  for (const c of channels) present.set(c.id, c);

  // Who hosts whom. A parent outside the list hosts nothing, so the child
  // hangs off the organisation node rather than disappearing.
  const hostOf = (c: GraphChannel): string =>
    c.parent_id && present.has(c.parent_id) && c.parent_id !== c.id ? c.parent_id : ORG_NODE_ID;
  const childrenOf = new Map<string, GraphChannel[]>();
  for (const c of channels) {
    const host = hostOf(c);
    const list = childrenOf.get(host) ?? [];
    list.push(c);
    childrenOf.set(host, list);
  }
  // Levels before laterals, each alphabetical — the order is stated so it
  // cannot drift between the drawn graph and the list above it.
  const byName = (a: GraphChannel, b: GraphChannel) => a.name.localeCompare(b.name);
  for (const list of childrenOf.values()) {
    list.sort((a, b) => {
      const la = isLateral(a) ? 1 : 0, lb = isLateral(b) ? 1 : 0;
      return la - lb || byName(a, b);
    });
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  const org: GraphNode = {
    id: ORG_NODE_ID, name: opts.orgName, kind: 'org', tier: null, tierLabel: 'Organisation',
    depth: 0, parentId: null, childCount: 0, x: 0, y: 0, w: NODE_W, h: NODE_H, channel: null,
  };
  nodes.push(org);

  const walk = (c: GraphChannel, parentTier: number, depth: number, parentId: string): void => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    const lateral = isLateral(c);
    const tier = lateral ? parentTier : Math.min(parentTier + 1, MAX_TIER);
    const node: GraphNode = {
      id: c.id,
      name: c.name,
      kind: lateral ? 'lateral' : 'level',
      tier: lateral ? null : tier,
      tierLabel: lateral
        ? (c.is_broadcast ? 'Announcement' : 'Lateral')
        : nameForTier(tier, opts.levelNames),
      depth,
      parentId,
      childCount: 0,
      x: 0, y: 0, w: NODE_W, h: NODE_H,
      channel: c,
    };
    nodes.push(node);
    edges.push({from: parentId, to: c.id, lateral});
    for (const child of childrenOf.get(c.id) ?? []) {
      // A lateral's own children (unusual, but expressible) sit one tier below
      // the level the lateral belongs to — the same rule as a structural child.
      walk(child, tier, depth + 1, c.id);
    }
  };

  for (const c of childrenOf.get(ORG_NODE_ID) ?? []) walk(c, 0, 1, ORG_NODE_ID);
  // Totality sweep: rows reachable only through a cycle never got a walk from
  // the organisation node. Draw them under it rather than lose them.
  for (const c of channels) {
    if (!seen.has(c.id)) walk(c, 0, 1, ORG_NODE_ID);
  }

  // ── Layout (tidy tree): a subtree is as wide as its children side by side ──
  const kids = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const list = kids.get(n.parentId) ?? [];
    list.push(n);
    kids.set(n.parentId, list);
  }
  for (const n of nodes) n.childCount = kids.get(n.id)?.length ?? 0;

  const widthOf = new Map<string, number>();
  const measure = (n: GraphNode): number => {
    const ch = kids.get(n.id) ?? [];
    const w = ch.length === 0
      ? NODE_W
      : Math.max(NODE_W, ch.reduce((s, k) => s + measure(k), 0) + H_GAP * (ch.length - 1));
    widthOf.set(n.id, w);
    return w;
  };
  measure(org);

  let maxDepth = 0;
  const place = (n: GraphNode, left: number): void => {
    const w = widthOf.get(n.id) ?? NODE_W;
    n.x = left + (w - NODE_W) / 2;
    n.y = PAD + n.depth * (NODE_H + V_GAP);
    maxDepth = Math.max(maxDepth, n.depth);
    let cursor = left;
    for (const k of kids.get(n.id) ?? []) {
      place(k, cursor);
      cursor += (widthOf.get(k.id) ?? NODE_W) + H_GAP;
    }
  };
  place(org, PAD);

  return {
    nodes,
    edges,
    width: PAD * 2 + (widthOf.get(org.id) ?? NODE_W),
    height: PAD * 2 + (maxDepth + 1) * NODE_H + maxDepth * V_GAP,
  };
}

/** An elbow from a parent's bottom-centre to a child's top-centre. */
export function edgePath(from: GraphNode, to: GraphNode): string {
  const x1 = from.x + from.w / 2, y1 = from.y + from.h;
  const x2 = to.x + to.w / 2, y2 = to.y;
  const ym = y1 + (y2 - y1) / 2;
  return `M ${x1} ${y1} V ${ym} H ${x2} V ${y2}`;
}

/** Trim a label to fit a node without a measuring pass. */
export function fitLabel(s: string, max = 22): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
