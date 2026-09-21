/**
 * B-852 (founder, 2026-09-11) — "Root sees all, labelled; members see own."
 *
 * The coverage calendar painted every rider's protection dates with no hint of
 * WHOSE they were: the plan holder could not tell their own bookings from a
 * linked member's, and a member saw (and could RELEASE) everyone else's.
 *
 * The server half (P1/D1/D2) scopes the read and the cancel. This file pins the
 * pure CLIENT half: who requested a mission, which filter chips that produces,
 * and how a chip narrows the list. The client renders what it is given — it
 * never assumes the server already hid anything.
 *
 * RED before the fix: `requesterOf` / `requesterChips` / `filterByRequester`
 * did not exist, and `ProPlanMission` carried no `requested_by_name`.
 *
 * Critic round 1 — the viewer is a `PlanViewer`, not a bare `holderId`. A
 * MEMBER cannot know the holder's id, so `holderId` is null for them, and a
 * legacy NULL `requested_by` used to collapse to "mine" on that path: the
 * member was offered RELEASE on the holder's own reserved date and the server
 * answered 403. A NULL owner is the viewer's own ONLY when the viewer holds
 * the plan (`isHolder`).
 */
import type {ProPlanMission} from '@services/api';
import {
  requesterOf, requesterChips, filterByRequester, UNKNOWN_REQUESTER_NAME,
  type PlanViewer,
} from '@screens/securepro/calendarMissions';

const HOLDER = '11111111-1111-4111-8111-1111111111aa';
const JACK   = '22222222-2222-4222-8222-2222222222bb';
const MARY   = '33333333-3333-4333-8333-3333333333cc';

/** The two seats, spelled exactly as the screens derive them. */
const AS_HOLDER: PlanViewer = {isHolder: true, holderId: HOLDER};
const AS_MEMBER: PlanViewer = {isHolder: false, holderId: null};

const mission = (
  id: string,
  requested_by: string | null,
  extra: Partial<ProPlanMission> = {},
): ProPlanMission => ({
  id,
  application_id: 'app-1',
  requested_by,
  mission_dates: ['2026-09-10'],
  note: null,
  status: 'SCHEDULED',
  assigned_team: [],
  ops_note: null,
  created_at: '2026-09-01T00:00:00.000Z',
  ...extra,
});

describe('requesterOf — who booked this mission, from the viewer\'s seat', () => {
  it('H1 the viewer\'s own request is `self` — never labelled', () => {
    expect(requesterOf(mission('m1', HOLDER), HOLDER, AS_HOLDER)).toEqual({kind: 'self'});
    expect(requesterOf(mission('m2', JACK), JACK, AS_MEMBER)).toEqual({kind: 'self'});
  });

  it('H2 someone else\'s request carries their display name', () => {
    expect(requesterOf(mission('m1', JACK, {requested_by_name: 'Jack Ryan'}), HOLDER, AS_HOLDER))
      .toEqual({kind: 'other', name: 'Jack Ryan'});
  });

  it('H3 a nameless requester falls back — an old server sends no name at all', () => {
    for (const name of [null, undefined, '   ']) {
      expect(requesterOf(mission('m1', JACK, {requested_by_name: name}), HOLDER, AS_HOLDER))
        .toEqual({kind: 'other', name: UNKNOWN_REQUESTER_NAME});
    }
    expect(UNKNOWN_REQUESTER_NAME).toBe('a member');
  });

  it('H4 a legacy NULL requested_by is the HOLDER\'s — self only for the holder', () => {
    expect(requesterOf(mission('m1', null), HOLDER, AS_HOLDER)).toEqual({kind: 'self'});
    // Even with no holderId to resolve it against: `isHolder` is the fact.
    expect(requesterOf(mission('m1', null), HOLDER, {isHolder: true, holderId: null}))
      .toEqual({kind: 'self'});
  });

  it('H5 a legacy NULL requested_by read by a MEMBER is the holder\'s, not theirs', () => {
    // The member cannot know the holder's id, so this is exactly how the screen
    // calls it: holderId null. Collapsing to `self` here is what offered them a
    // RELEASE button the server refuses with 403 not_your_mission.
    expect(requesterOf(mission('m1', null, {requested_by_name: 'Baine Kriel'}), JACK, AS_MEMBER))
      .toEqual({kind: 'other', name: 'Baine Kriel'});
    expect(requesterOf(mission('m1', null), JACK, AS_MEMBER))
      .toEqual({kind: 'other', name: UNKNOWN_REQUESTER_NAME});
  });

  it('H6 with no viewer id the helper stays QUIET rather than guessing', () => {
    // Why: a wrong "Booked by …" on the viewer's own row is worse than no line,
    // and `selfId` is undefined for a tick on a cold boot.
    expect(requesterOf(mission('m1', JACK), undefined, AS_HOLDER)).toEqual({kind: 'self'});
    expect(requesterOf(mission('m1', null), undefined, AS_MEMBER)).toEqual({kind: 'self'});
  });
});

describe('requesterChips — a filter per person, only when there IS more than one', () => {
  it('H7 one requester (all the viewer\'s own) produces NO chips', () => {
    expect(requesterChips(
      [mission('a', HOLDER), mission('b', HOLDER), mission('c', null)],
      HOLDER, AS_HOLDER,
    )).toEqual([]);
  });

  it('H8 a single OTHER requester and nothing of the viewer\'s own is still one requester', () => {
    expect(requesterChips([mission('a', JACK, {requested_by_name: 'Jack'})], HOLDER, AS_HOLDER))
      .toEqual([]);
  });

  it('H9 two requesters produce All · You · the member', () => {
    expect(requesterChips(
      [mission('a', HOLDER), mission('b', JACK, {requested_by_name: 'Jack'})],
      HOLDER, AS_HOLDER,
    )).toEqual([
      {key: 'all', label: 'All'},
      {key: 'self', label: 'You'},
      {key: JACK, label: 'Jack'},
    ]);
  });

  it('H10 two members sharing a display name are told apart by their id tail', () => {
    const chips = requesterChips([
      mission('a', HOLDER),
      mission('b', JACK, {requested_by_name: 'Jack'}),
      mission('c', MARY, {requested_by_name: 'jack '}),
    ], HOLDER, AS_HOLDER);
    expect(chips.map(c => c.key)).toEqual(['all', 'self', JACK, MARY]);
    expect(chips[2].label).toBe('Jack · ID 22BB');
    expect(chips[3].label).toBe('jack · ID 33CC');
  });

  it('H11 the You chip is omitted when the viewer booked nothing — it would filter to an empty list', () => {
    const chips = requesterChips([
      mission('a', JACK, {requested_by_name: 'Jack'}),
      mission('b', MARY, {requested_by_name: 'Mary'}),
    ], HOLDER, AS_HOLDER);
    expect(chips).toEqual([
      {key: 'all', label: 'All'},
      {key: JACK, label: 'Jack'},
      {key: MARY, label: 'Mary'},
    ]);
  });

  it('H12 an empty plan has no chips', () => {
    expect(requesterChips([], HOLDER, AS_HOLDER)).toEqual([]);
  });
});

describe('filterByRequester — one key narrows paint, list and sheets together', () => {
  const MISSIONS = [
    mission('own', HOLDER),
    mission('legacy', null),
    mission('jack', JACK, {requested_by_name: 'Jack'}),
    mission('mary', MARY, {requested_by_name: 'Mary'}),
  ];

  it('H13 `all` hands back the SAME array — identity, so the memos below it do not churn', () => {
    expect(filterByRequester(MISSIONS, 'all', HOLDER, AS_HOLDER)).toBe(MISSIONS);
  });

  it('H14 `self` keeps the viewer\'s own, legacy rows included FOR THE HOLDER', () => {
    expect(filterByRequester(MISSIONS, 'self', HOLDER, AS_HOLDER).map(m => m.id))
      .toEqual(['own', 'legacy']);
  });

  it('H15 a member key keeps only that member\'s', () => {
    expect(filterByRequester(MISSIONS, JACK, HOLDER, AS_HOLDER).map(m => m.id)).toEqual(['jack']);
    expect(filterByRequester(MISSIONS, MARY, HOLDER, AS_HOLDER).map(m => m.id)).toEqual(['mary']);
  });

  it('H16 an unknown key narrows to nothing rather than silently showing everything', () => {
    expect(filterByRequester(MISSIONS, 'nobody', HOLDER, AS_HOLDER)).toEqual([]);
  });

  it('H17 for a MEMBER, `self` never sweeps in the holder\'s legacy row', () => {
    expect(filterByRequester(MISSIONS, 'self', JACK, AS_MEMBER).map(m => m.id)).toEqual(['jack']);
  });
});
