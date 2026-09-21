/**
 * Coverage Calendar mission model — pure, node-testable.
 *
 * B-821 (founder, 2026-09-07): "user booked 10 different bookings on different
 * days, those days are not marked to show these are the booked days. And if I
 * click on those days the user should be able to see all the necessary
 * information." A COMPLETED mission painted nothing distinct (it fell into the
 * SCHEDULED bucket), and no surface answered "what happened on this day".
 */
import type {ProPlanMission} from '@services/api';
import {collidingOrgNames, shortOrgRef} from '@screens/deptchat/orgDisambiguation';

export type PaintedStatus = 'SCHEDULED' | 'COMPLETED' | 'REQUESTED';

const PAINT_RANK: Record<PaintedStatus, number> = {SCHEDULED: 0, COMPLETED: 1, REQUESTED: 2};

/** Detail-sheet order within one day: what is live first, what is dead last. */
const DETAIL_RANK: Record<ProPlanMission['status'], number> = {
  SCHEDULED: 0,
  REQUESTED: 1,
  COMPLETED: 2,
  DECLINED: 3,
  CANCELLED: 4,
};

/**
 * Detail-sheet status pill. An explicit tone per status, NOT `color + '14'`
 * string arithmetic: two of these tones are rgba tokens, and appending hex
 * alpha to `rgba(...)` yields a string RN cannot parse (it drops the fill
 * silently). The literals mirror the screen's `D` palette.
 */
export const MISSION_STATUS_TONE: Record<
  ProPlanMission['status'],
  {color: string; bg: string; border: string}
> = {
  REQUESTED: {color: '#F5C76B', bg: 'rgba(245,199,107,0.08)', border: 'rgba(245,199,107,0.3)'},
  SCHEDULED: {color: '#4ADE80', bg: 'rgba(74,222,128,0.08)', border: 'rgba(74,222,128,0.3)'},
  COMPLETED: {color: '#A9C5FF', bg: 'rgba(91,141,239,0.12)', border: 'rgba(91,141,239,0.4)'},
  DECLINED: {color: '#FF5D5D', bg: 'rgba(255,93,93,0.08)', border: 'rgba(255,93,93,0.3)'},
  CANCELLED: {color: 'rgba(180,188,204,0.45)', bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.09)'},
};

/** date → the strongest status painting it (SCHEDULED > COMPLETED > REQUESTED). */
export function paintedDateStatus(missions: readonly ProPlanMission[]): Map<string, PaintedStatus> {
  const map = new Map<string, PaintedStatus>();
  for (const mi of missions) {
    // Why: a released date must stop painting the grid the moment it is
    // CANCELLED — otherwise E2E-07 just moves the lie from ops to the calendar.
    if (mi.status === 'DECLINED' || mi.status === 'CANCELLED') {continue;}
    const tag: PaintedStatus = mi.status;
    for (const d of mi.mission_dates) {
      const cur = map.get(d);
      if (cur === undefined || PAINT_RANK[tag] < PAINT_RANK[cur]) {map.set(d, tag);}
    }
  }
  return map;
}

/**
 * date → every mission touching it, declined and cancelled INCLUDED: a tap has
 * to be able to explain why a day the client asked for is not covered.
 */
export function missionsByDate(missions: readonly ProPlanMission[]): Map<string, ProPlanMission[]> {
  const map = new Map<string, ProPlanMission[]>();
  for (const mi of missions) {
    for (const d of mi.mission_dates) {
      const list = map.get(d);
      if (list) {list.push(mi);} else {map.set(d, [mi]);}
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) =>
      DETAIL_RANK[a.status] - DETAIL_RANK[b.status] ||
      (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }
  return map;
}

/**
 * ── B-852 · WHO BOOKED THIS MISSION ──────────────────────────────────────
 *
 * A linked member (B-843 ride-along) requests protection dates on the ROOT's
 * application, so one plan's calendar can hold several people's bookings. The
 * founder's rule: the root sees them all, labelled, with a filter per person;
 * a member sees only their own.
 *
 * Scoping is a DATA-ACCESS rule and lives on the server. This model is only the
 * label: it renders what arrived and assumes nothing was hidden for it.
 */
export type MissionRequester = {kind: 'self'} | {kind: 'other'; name: string};

/** No name on the wire (an older server projects none). Never a blank line. */
export const UNKNOWN_REQUESTER_NAME = 'a member';

export interface RequesterChip {key: string; label: string}

/** Chip keys that are not a user id. A uuid can never collide with these. */
export const REQUESTER_ALL = 'all';
export const REQUESTER_SELF = 'self';

/**
 * The seat the calendar is being read from.
 *
 * `isHolder` and `holderId` are NOT the same fact and one cannot stand in for
 * the other. A MEMBER riding the holder's plan has no way to know the holder's
 * user id, so `holderId` is null for them — and treating "no owner id" as
 * "mine" is exactly how a member was offered RELEASE on the holder's own
 * reserved date, which the server then refuses with 403 not_your_mission.
 */
export interface PlanViewer {
  /** The viewer HOLDS this plan — the application carries no `via_owner`. */
  isHolder: boolean;
  /** The holder's user id, knowable only when it is the viewer's own. */
  holderId?: string | null;
}

/**
 * The user this mission belongs to, or null when the client cannot name them.
 * `requested_by` is NULL on rows minted before members could ride a plan —
 * those are the HOLDER's, whose id only the holder themselves can supply.
 */
function ownerIdOf(
  mi: Pick<ProPlanMission, 'requested_by'>,
  viewer: PlanViewer,
): string | null {
  return mi.requested_by ?? viewer.holderId ?? null;
}

/**
 * Who booked this, from the viewer's seat.
 *
 * Deliberately QUIET when the VIEWER is unknown: labelling their OWN row
 * "Booked by someone" is a worse failure than the missing line this bug is
 * about, and `selfId` is absent for a tick on a cold boot.
 */
export function requesterOf(
  mi: Pick<ProPlanMission, 'requested_by' | 'requested_by_name'>,
  selfId: string | null | undefined,
  viewer: PlanViewer,
): MissionRequester {
  if (!selfId) {return {kind: 'self'};}
  const owner = ownerIdOf(mi, viewer);
  // An unattributable row is the HOLDER's. That is the viewer's own only when
  // the viewer holds the plan — never on a member's reading of it.
  if (owner === null) {return viewer.isHolder ? {kind: 'self'} : namedOther(mi);}
  return owner === selfId ? {kind: 'self'} : namedOther(mi);
}

function namedOther(
  mi: Pick<ProPlanMission, 'requested_by_name'>,
): MissionRequester {
  return {kind: 'other', name: (mi.requested_by_name ?? '').trim() || UNKNOWN_REQUESTER_NAME};
}

/**
 * All · You · one chip per other requester — and NOTHING at all below two
 * distinct requesters, which is the overwhelmingly common single-rider plan.
 *
 * "You" is omitted when the viewer booked none of these dates: a chip that
 * filters to an empty list is a dead end, not a filter.
 *
 * Two members can share a display name, so chips are keyed by USER ID and only
 * the colliding labels take the id tail — the A7 rule from the Channels
 * surface, reused rather than re-derived.
 */
export function requesterChips(
  missions: readonly ProPlanMission[],
  selfId: string | null | undefined,
  viewer: PlanViewer,
): RequesterChip[] {
  let hasSelf = false;
  const others = new Map<string, string>();
  for (const mi of missions) {
    const who = requesterOf(mi, selfId, viewer);
    if (who.kind === 'self') {hasSelf = true; continue;}
    // An unattributable row (a member reading the holder's legacy booking) is
    // labelled but gets no chip: there is no id to key one on. It stays visible
    // under All, which is the only view that can honestly show it.
    const owner = ownerIdOf(mi, viewer);
    if (owner && !others.has(owner)) {others.set(owner, who.name);}
  }
  if ((hasSelf ? 1 : 0) + others.size < 2) {return [];}

  const sorted = [...others.entries()].sort(
    (a, b) => a[1].toLowerCase().localeCompare(b[1].toLowerCase()) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  const colliding = collidingOrgNames(sorted.map(([, name]) => name));
  return [
    {key: REQUESTER_ALL, label: 'All'},
    ...(hasSelf ? [{key: REQUESTER_SELF, label: 'You'}] : []),
    ...sorted.map(([id, name]) => ({
      key: id,
      label: colliding.has(name.trim().toLowerCase()) ? `${name} · ${shortOrgRef(id)}` : name,
    })),
  ];
}

/**
 * The missions one chip shows. `all` hands the SAME array back so the memos
 * hanging off it (paint, day index, month counts) keep their identity.
 */
export function filterByRequester(
  missions: readonly ProPlanMission[],
  key: string,
  selfId: string | null | undefined,
  viewer: PlanViewer,
): readonly ProPlanMission[] {
  if (key === REQUESTER_ALL) {return missions;}
  if (key === REQUESTER_SELF) {
    return missions.filter(mi => requesterOf(mi, selfId, viewer).kind === 'self');
  }
  return missions.filter(
    mi => requesterOf(mi, selfId, viewer).kind === 'other' && ownerIdOf(mi, viewer) === key,
  );
}

/** Painted-day counts per pager page, in pager order, months with none dropped. */
export function paintedDaysByMonth(
  painted: ReadonlyMap<string, PaintedStatus>,
  months: ReadonlyArray<readonly [number, number]>,
): Array<{ix: number; count: number}> {
  const counts = new Map<string, number>();
  for (const iso of painted.keys()) {
    const key = iso.slice(0, 7);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: Array<{ix: number; count: number}> = [];
  months.forEach(([y, m], ix) => {
    const count = counts.get(`${y}-${`${m + 1}`.padStart(2, '0')}`) ?? 0;
    if (count > 0) {out.push({ix, count});}
  });
  return out;
}
