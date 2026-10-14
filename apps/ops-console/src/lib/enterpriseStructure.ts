/**
 * Enterprise structure editor (2026-10-15) — pure helpers behind
 * /enterprise/departments/[id]/structure.
 *
 * The page shows an organisation's channel tree the way the app's Channels tab
 * does (organisation › country › province › area, each node with its own
 * channels), plus who is placed where. Kept free of React so the ordering and
 * the placement copy are unit-tested.
 */
import type {StructureChannel, StructureMember, StructurePostMode, StructureTemplates} from './api';
import {nameForTier} from './orgGraph';

export const MAX_STRUCTURE_LEVEL = 3;

export interface StructureRow {
  channel: StructureChannel;
  /** 0 for the organisation row(s); a lateral sits one step in from its node. */
  depth: number;
  kind: 'node' | 'lateral';
  /** Display tier 1..4 for a node (depth-based, like the app); null for a lateral. */
  tier: number | null;
  /** Members placed AT this node (not below it). */
  placed: number;
}

export const POST_MODE_OPTIONS: ReadonlyArray<{value: StructurePostMode; label: string; hint: string}> = [
  {value: 'open', label: 'Open chat', hint: 'everyone in it can post'},
  {value: 'announcement', label: 'Announcements', hint: 'only admins and managers post'},
  {value: 'read_only', label: 'Read-only', hint: 'admins post, members read'},
  {value: 'admin_only', label: 'Admins only', hint: 'admins post and discuss'},
];

export function postModeLabel(mode: StructurePostMode): string {
  return POST_MODE_OPTIONS.find(o => o.value === mode)?.label ?? mode;
}

/**
 * Depth-first: a node, then its own channels (laterals), then its child nodes.
 * Archived rows are dropped unless asked for; an archived node's subtree goes
 * with it. Siblings keep creation order, which is what the server returns.
 */
export function buildStructureRows(
  channels: readonly StructureChannel[],
  members: readonly StructureMember[] = [],
  opts: {showArchived?: boolean} = {},
): StructureRow[] {
  const visible = channels.filter(c => opts.showArchived || !c.archived);
  const ids = new Set(visible.map(c => c.id));
  const kids = new Map<string | null, StructureChannel[]>();
  for (const c of visible) {
    // A parent outside the visible set (archived and hidden) makes the row a
    // root of the listing rather than vanishing it.
    const key = c.parent_id && ids.has(c.parent_id) ? c.parent_id : null;
    const list = kids.get(key) ?? [];
    list.push(c);
    kids.set(key, list);
  }
  const placedAt = new Map<string, number>();
  for (const m of members) {
    if (m.placement_channel_id) {placedAt.set(m.placement_channel_id, (placedAt.get(m.placement_channel_id) ?? 0) + 1);}
  }
  const out: StructureRow[] = [];
  const seen = new Set<string>();
  const walk = (c: StructureChannel, depth: number, tier: number | null) => {
    if (seen.has(c.id) || depth > 12) {return;}
    seen.add(c.id);
    const lateral = c.is_lateral || c.is_broadcast;
    out.push({channel: c, depth, kind: lateral ? 'lateral' : 'node', tier: lateral ? null : tier,
      placed: placedAt.get(c.id) ?? 0});
    const children = kids.get(c.id) ?? [];
    for (const l of children.filter(x => x.is_lateral || x.is_broadcast)) {walk(l, depth + 1, null);}
    for (const n of children.filter(x => !(x.is_lateral || x.is_broadcast))) {
      walk(n, depth + 1, Math.min((tier ?? 0) + 1, MAX_STRUCTURE_LEVEL + 1));
    }
  };
  for (const root of kids.get(null) ?? []) {walk(root, 0, root.is_lateral || root.is_broadcast ? null : 1);}
  return out;
}

/** Can ops add a child NODE under this one? Levels are 0..3 in the database. */
export function canAddChildNode(c: Pick<StructureChannel, 'level' | 'is_lateral' | 'is_broadcast' | 'archived'>): boolean {
  return !c.archived && !c.is_lateral && !c.is_broadcast && c.level < MAX_STRUCTURE_LEVEL;
}

/** The template list a NEW child of `parentLevel` would receive (null = new organisation). */
export function templatesForNewChild(templates: StructureTemplates, parentLevel: number | null) {
  const level = parentLevel === null ? 0 : parentLevel + 1;
  return templates[String(Math.min(level, MAX_STRUCTURE_LEVEL)) as keyof StructureTemplates] ?? [];
}

/** "Gauteng Province · South Africa · GardaWorld Africa" — where a member sits. */
export function placementPath(channels: readonly StructureChannel[], id: string | null): string {
  if (!id) {return 'Whole organisation';}
  const byId = new Map(channels.map(c => [c.id, c]));
  const parts: string[] = [];
  let cur = byId.get(id);
  for (let hop = 0; hop < 6 && cur; hop++) {
    parts.push(cur.name);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return parts.length ? parts.join(' › ') : 'Removed node';
}

export function placementStateLabel(m: Pick<StructureMember, 'placement_state'>): string | null {
  switch (m.placement_state) {
    case 'missing': return 'Node deleted — sees broadcasts only. Place again.';
    case 'archived': return 'Node archived — place again.';
    default: return null;
  }
}

/** Template level header, e.g. "L3 · Sub". */
export function templateLevelLabel(level: number, levelNames?: readonly string[] | null): string {
  return `L${level + 1} · ${nameForTier(level + 1, levelNames)}`;
}

/** Validate an edited template set before it is sent (mirrors the server). */
export function templateProblems(t: StructureTemplates): string | null {
  for (const level of ['0', '1', '2', '3'] as const) {
    const seen = new Set<string>();
    for (const e of t[level]) {
      const name = e.name.trim();
      if (!name) {return `L${Number(level) + 1}: every channel needs a name.`;}
      if (name.length > 80) {return `L${Number(level) + 1}: "${name.slice(0, 20)}…" is longer than 80 characters.`;}
      const k = name.toLowerCase();
      if (seen.has(k)) {return `L${Number(level) + 1}: "${name}" appears twice.`;}
      seen.add(k);
    }
    if (t[level].length > 12) {return `L${Number(level) + 1}: at most 12 channels per level.`;}
  }
  return null;
}
