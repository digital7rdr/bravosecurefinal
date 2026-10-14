import type {ChannelAccess, ChannelPostMode, ChannelType} from './dto/channel.dto';

/**
 * Enterprise structure (2026-10-15) — WHICH channels a PLACED member belongs to.
 *
 * Founder request: "enterprise department channels — parent company,
 * departments, child entities and sub-entities, configurable from the
 * backend", with every node also being a chat and a member placed at a node
 * seeing "their node and everything below, plus the parents' broadcast
 * channels".
 *
 * `org_members.placement_channel_id` names that node. NULL means "the whole
 * organisation", which is exactly how every member behaved before placement
 * existed, so no existing roster changes until ops places someone.
 *
 * The grant for a placement P:
 *   - P itself and everything beneath it (sub-nodes and their laterals) —
 *     a full MEMBER, posting by the channel's own post mode;
 *   - every ancestor node of P — READ-ONLY. They are what makes the member's
 *     tree read "GardaWorld Africa › South Africa › Gauteng › Johannesburg"
 *     instead of "(not shown)" rungs, and a reader cannot post into a level
 *     they do not belong to;
 *   - each ancestor's ONE-WAY laterals (announcement / read-only, e.g.
 *     "Provincial Broadcast", "Knowledge Hub") — READ-ONLY. An ancestor's
 *     OPEN laterals ("Committees") stay with the people placed at that level;
 *   - the organisation's #broadcast rows — READ-ONLY, for the reason
 *     seed-path.ts addOrgBroadcasts records (a broadcast is level-scoped, and
 *     losing announcements is worse than seeing one too many).
 *
 * A PURE FUNCTION over rows, like resolveSeedScope, for the same reason: the
 * rule is a graph decision and no unit test in this project executes SQL.
 *
 * FAIL CLOSED. A placement that names a channel which no longer exists grants
 * the broadcasts only — never the whole organisation. (That is why the column
 * has no ON DELETE SET NULL foreign key: SET NULL would silently turn a
 * deleted node into an org-wide grant on the next seed.)
 */

export interface PlacementRow {
  id: string;
  parent_id: string | null;
  is_lateral: boolean;
  is_broadcast: boolean;
  post_mode: ChannelPostMode | null;
  access: ChannelAccess;
  channel_type: ChannelType;
  /** Archived rows MUST be passed in (walk scaffolding, never granted). */
  archived?: boolean;
}

/** 'member' = posts by the channel's post mode; 'reader' = always viewer. */
export type PlacementKind = 'member' | 'reader';
export type PlacementGrant = Map<string, PlacementKind>;

/** Levels are CHECKed 0..3; four hops is the deepest any walk can need. */
const MAX_HOPS = 4;

/** One-way laterals an ancestor shares downwards. */
export function isOneWay(row: Pick<PlacementRow, 'is_broadcast' | 'post_mode'>): boolean {
  return row.is_broadcast || row.post_mode === 'announcement' || row.post_mode === 'read_only';
}

/**
 * @param managersOnly the visibility rule (DepartmentService.seedsManagersOnly)
 *        injected rather than imported, so this file stays free of the service
 *        and its one-answerer invariant is not restated here.
 * @returns null when the member is unplaced (org-wide, today's behaviour).
 */
export function placementGrant(
  rows: readonly PlacementRow[],
  placementId: string | null,
  asManager: boolean,
  managersOnly: (access: ChannelAccess, channelType: ChannelType) => boolean,
): PlacementGrant | null {
  if (!placementId) {return null;}
  const byId = new Map(rows.map(r => [r.id, r]));
  const childrenOf = new Map<string, PlacementRow[]>();
  for (const r of rows) {
    if (!r.parent_id) {continue;}
    const list = childrenOf.get(r.parent_id) ?? [];
    list.push(r);
    childrenOf.set(r.parent_id, list);
  }
  const grant: PlacementGrant = new Map();
  const visible = (r: PlacementRow) => !r.archived && (asManager || !managersOnly(r.access, r.channel_type));
  const give = (r: PlacementRow, kind: PlacementKind) => {
    if (!visible(r)) {return;}
    // 'member' always wins over 'reader' for the same row.
    if (grant.get(r.id) === 'member') {return;}
    grant.set(r.id, kind);
  };

  const node = byId.get(placementId);
  if (node) {
    // The node and its whole subtree. Breadth-first and bounded: a cycle is
    // refused by a trigger, but this runs on the request path.
    give(node, 'member');
    let frontier = [node.id];
    for (let hop = 0; hop < MAX_HOPS && frontier.length; hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const c of childrenOf.get(id) ?? []) {
          // Climb through an archived child only to reach nothing: an archived
          // node cannot hold active children, so its subtree is all archived.
          give(c, 'member');
          next.push(c.id);
        }
      }
      frontier = next;
    }
    // Ancestors (read-only) and their one-way laterals.
    let cur = node.parent_id ? byId.get(node.parent_id) : undefined;
    for (let hop = 0; hop < MAX_HOPS && cur; hop++) {
      give(cur, 'reader');
      for (const c of childrenOf.get(cur.id) ?? []) {
        if (c.is_lateral && isOneWay(c)) {give(c, 'reader');}
      }
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
  }
  for (const r of rows) {
    if (r.is_broadcast) {give(r, 'reader');}
  }
  return grant;
}
