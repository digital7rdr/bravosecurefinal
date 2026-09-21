/**
 * B-848 — the workspace ENTRY rules, as the plan's persona table (§10 A6).
 *
 * These four predicates decide whether a person lands inside one organisation,
 * on a picker, or on the legacy single-org surface. The defect the client
 * reported ("not all organization must show when I open 1 organization") is
 * what a NULL context used to mean on the Channels directory: both scoping
 * belts are fail-open, so no context meant every organisation. Pure by design,
 * so the table can be asserted row by row instead of by mounting three screens.
 *
 * ⚠️ The row that is easiest to get wrong is the DEDUPE: for a
 * single-membership user the server puts the SAME org in `workspaces[0]` AND
 * in `org` (arms 2/4 of the primary-org precedence), so a naive union counts
 * that person as two and interrupts someone who has exactly one workspace.
 */
import {
  contextRoleFor, enterableAffiliations, hasAffiliationList, isEnterablePrimaryOrg,
  isPrimaryOrgContext, needsWorkspaceChoice, resolveWorkspaceEntry, type AffiliationUser,
} from '../workspaceEntry';

type Role = 'owner' | 'manager' | 'employee' | 'cpo';

const ME = 'aaaa0000-bbbb-4ccc-8ddd-eeeeffff0000';
const OWN = ME;
const ACME = 'aaaa1111-bbbb-4ccc-8ddd-eeeeffff0001';
const BOREALIS = 'aaaa2222-bbbb-4ccc-8ddd-eeeeffff0002';
const AGENCY = 'aaaa3333-bbbb-4ccc-8ddd-eeeeffff0003';

const ws = (org_id: string, name: string, role: Role) => ({org_id, name, role});

describe('hasAffiliationList — undefined is NOT an empty list', () => {
  it('is false for an old server, true for a server that says zero', () => {
    // The whole compatibility story: `undefined` = "cannot vouch" → legacy
    // behaviour; `[]` = "zero enterable workspaces", a real answer.
    expect(hasAffiliationList({id: ME})).toBe(false);
    expect(hasAffiliationList({id: ME, workspaces: []})).toBe(true);
    expect(hasAffiliationList(null)).toBe(false);
  });
});

describe('contextRoleFor — is_org_manager outranks account_kind', () => {
  it('names the OWNER only for the caller\'s own org row', () => {
    expect(contextRoleFor({id: ME}, ME)).toBe('owner');
    expect(contextRoleFor({id: ME}, ACME)).toBe('employee');
  });

  it('a PROMOTED CPO keeps manager chrome (critic P0)', () => {
    // `account_kind` stays 'cpo' when a CPO is promoted to org manager, so
    // testing the kind first strips manager chrome from exactly the persona
    // `is_org_manager` exists to describe.
    expect(contextRoleFor({id: ME, account_kind: 'cpo', is_org_manager: true}, AGENCY))
      .toBe('manager');
  });

  it('an unpromoted CPO is an officer, everyone else an employee', () => {
    expect(contextRoleFor({id: ME, account_kind: 'cpo'}, AGENCY)).toBe('cpo');
    expect(contextRoleFor({id: ME, account_kind: 'individual'}, ACME)).toBe('employee');
  });
});

describe('enterableAffiliations — the A6 persona table', () => {
  const ids = (u: AffiliationUser) => enterableAffiliations(u).map(w => w.org_id);

  it('individual, no workspaces → nothing to enter, never a picker', () => {
    const u: AffiliationUser = {id: ME, workspaces: []};
    expect(ids(u)).toEqual([]);
    expect(resolveWorkspaceEntry(u, null)).toBeNull();
    expect(needsWorkspaceChoice(u, null)).toBe(false);
  });

  it('individual with ONE workspace → that one, and the duplicate `org` row is deduped', () => {
    // THE DEDUPE ROW. `org` repeats `workspaces[0]` for this persona.
    const u: AffiliationUser = {
      id: ME,
      workspaces: [ws(ACME, 'Acme', 'employee')],
      org: {id: ACME, name: 'Acme'},
    };
    expect(ids(u)).toEqual([ACME]);
    expect(resolveWorkspaceEntry(u, null)).toEqual({org_id: ACME, name: 'Acme', role: 'employee'});
    expect(needsWorkspaceChoice(u, null)).toBe(false);
  });

  it('the workspaces row WINS the dedupe — its role is the server\'s own answer', () => {
    // `contextRoleFor` is a client-side reconstruction; the membership row is
    // the server's. An owner browsing a workspace they joined as an employee
    // must get the member UI, not manager chrome.
    const u: AffiliationUser = {
      id: ME, is_org_manager: true,
      workspaces: [ws(ACME, 'Acme', 'employee')],
      org: {id: ACME, name: 'Acme'},
    };
    expect(enterableAffiliations(u)).toEqual([{org_id: ACME, name: 'Acme', role: 'employee'}]);
  });

  it('active owner with no other membership → their own workspace', () => {
    const u: AffiliationUser = {
      id: ME,
      workspaces: [ws(OWN, 'Bravo Advisory', 'owner')],
      org: {id: OWN, name: 'Bravo Advisory'},
    };
    expect(resolveWorkspaceEntry(u, null))
      .toEqual({org_id: OWN, name: 'Bravo Advisory', role: 'owner'});
  });

  it('active owner who ALSO belongs elsewhere → two, so the picker', () => {
    const u: AffiliationUser = {
      id: ME,
      workspaces: [ws(OWN, 'Bravo Advisory', 'owner'), ws(ACME, 'Acme', 'employee')],
      org: {id: ACME, name: 'Acme'},
    };
    expect(ids(u)).toEqual([OWN, ACME]);
    expect(resolveWorkspaceEntry(u, null)).toBeNull();
    expect(needsWorkspaceChoice(u, null)).toBe(true);
  });

  it('lapsed owner with one membership → that membership (the hub card stays informational)', () => {
    // `owns_workspace` is lapse-gated, so their own workspace is absent from
    // the array and the primary-org resolution falls through to the employer.
    const u: AffiliationUser = {
      id: ME, workspaces: [ws(ACME, 'Acme', 'employee')], org: {id: ACME, name: 'Acme'},
    };
    expect(resolveWorkspaceEntry(u, null)).toEqual({org_id: ACME, name: 'Acme', role: 'employee'});
  });

  it('lapsed owner with no memberships → nothing enterable', () => {
    const u: AffiliationUser = {id: ME, workspaces: [], org: null};
    expect(ids(u)).toEqual([]);
    expect(needsWorkspaceChoice(u, null)).toBe(false);
  });

  it('agency manager with no workspace → their AGENCY, as a manager', () => {
    // An agency org is structurally absent from `workspaces` (the affiliation
    // SQL inner-joins org_workspaces), which is the whole reason `org` is read.
    const u: AffiliationUser = {
      id: ME, account_kind: 'agency', is_org_manager: true,
      workspaces: [], org: {id: AGENCY, name: 'Meridian Protective'},
    };
    expect(resolveWorkspaceEntry(u, null))
      .toEqual({org_id: AGENCY, name: 'Meridian Protective', role: 'manager'});
  });

  it('agency manager who also owns a workspace → two, so the picker', () => {
    const u: AffiliationUser = {
      id: ME, account_kind: 'agency', is_org_manager: true,
      workspaces: [ws(OWN, 'Side Project', 'owner')],
      org: {id: AGENCY, name: 'Meridian Protective'},
    };
    expect(ids(u)).toEqual([OWN, AGENCY]);
    expect(needsWorkspaceChoice(u, null)).toBe(true);
  });

  it('managed CPO with no workspace → the org they are managed by, as an officer', () => {
    const u: AffiliationUser = {
      id: ME, account_kind: 'cpo', workspaces: [],
      managed_org: {id: AGENCY, name: 'Meridian Protective'},
    };
    expect(resolveWorkspaceEntry(u, null))
      .toEqual({org_id: AGENCY, name: 'Meridian Protective', role: 'cpo'});
  });

  it('managed CPO who also belongs to a workspace → the picker', () => {
    const u: AffiliationUser = {
      id: ME, account_kind: 'cpo', workspaces: [ws(ACME, 'Acme', 'employee')],
      managed_org: {id: AGENCY, name: 'Meridian Protective'},
    };
    expect(ids(u)).toEqual([ACME, AGENCY]);
    expect(needsWorkspaceChoice(u, null)).toBe(true);
  });

  it('a company agent (org.id === user.id) enters as the OWNER', () => {
    const u: AffiliationUser = {
      id: ME, account_kind: 'agency', workspaces: [], org: {id: ME, name: 'Acme Security'},
    };
    expect(resolveWorkspaceEntry(u, null))
      .toEqual({org_id: ME, name: 'Acme Security', role: 'owner'});
  });

  it('`managed_org` is deduped against `org` when they are the same company', () => {
    const u: AffiliationUser = {
      id: ME, account_kind: 'cpo', workspaces: [],
      org: {id: AGENCY, name: 'Meridian Protective'},
      managed_org: {id: AGENCY, name: 'Meridian Protective'},
    };
    expect(ids(u)).toEqual([AGENCY]);
  });
});

describe('an old server never produces a list, an adoption or a picker', () => {
  it('`workspaces === undefined` yields nothing, whatever org/managed_org say', () => {
    // The fail-open reading of `undefined` is how a boot race would adopt
    // anything it was handed — and how a picker would interrupt a user the
    // server has said nothing at all about.
    const u: AffiliationUser = {
      id: ME, account_kind: 'agency', org: {id: AGENCY, name: 'Meridian Protective'},
      managed_org: {id: AGENCY, name: 'Meridian Protective'},
    };
    expect(enterableAffiliations(u)).toEqual([]);
    expect(needsWorkspaceChoice(u, null)).toBe(false);
    expect(resolveWorkspaceEntry(u, null)).toBeNull();
  });

  it('leaves a context that is already set completely alone', () => {
    const ctx = {org_id: ACME, name: 'Acme', role: 'employee'} as const;
    expect(resolveWorkspaceEntry({id: ME}, ctx)).toBe(ctx);
  });
});

describe('F1 — an org outside `workspaces` is enterable only if it is NOT a workspace', () => {
  /**
   * TWO very different reasons an org sits in `user.org` and not in
   * `user.workspaces`, and only one of them is enterable:
   *
   *   - an AGENCY has no `org_workspaces` row to inner-join, so it is absent by
   *     construction — entering it is the point of the hub's fallback card;
   *   - a LAPSED WORKSPACE drops OUT of the lapse-gated array while `org` keeps
   *     naming it, and it is not enterable (founder Q1: renew, do not open).
   */
  it('an employee whose EMPLOYER lapsed gets no affiliation, no card, no count', () => {
    const u: AffiliationUser = {
      id: ME, account_kind: 'individual',
      workspaces: [], org: {id: ACME, name: 'Acme'}, org_is_workspace: true,
    };
    expect(isEnterablePrimaryOrg(u)).toBe(false);
    expect(enterableAffiliations(u)).toEqual([]);
    expect(resolveWorkspaceEntry(u, null)).toBeNull();
    expect(needsWorkspaceChoice(u, null)).toBe(false);
  });

  it('…and it does not push a one-workspace person into the picker', () => {
    // The nastier half: a member of Borealis whose OTHER employer lapsed would
    // otherwise count as two and be interrupted by a picker whose second option
    // is a renewal notice they cannot act on.
    const u: AffiliationUser = {
      id: ME, workspaces: [ws(BOREALIS, 'Borealis', 'employee')],
      org: {id: ACME, name: 'Acme'}, org_is_workspace: true,
    };
    expect(enterableAffiliations(u).map(w => w.org_id)).toEqual([BOREALIS]);
    expect(needsWorkspaceChoice(u, null)).toBe(false);
    expect(resolveWorkspaceEntry(u, null))
      .toEqual({org_id: BOREALIS, name: 'Borealis', role: 'employee'});
  });

  it('an AGENCY CPO is enterable — its org is absent for a structural reason', () => {
    const u: AffiliationUser = {
      id: ME, account_kind: 'cpo', workspaces: [],
      org: {id: AGENCY, name: 'Meridian Protective'}, org_is_workspace: false,
    };
    expect(isEnterablePrimaryOrg(u)).toBe(true);
    expect(resolveWorkspaceEntry(u, null))
      .toEqual({org_id: AGENCY, name: 'Meridian Protective', role: 'cpo'});
  });

  it('an OLDER server that omits org_is_workspace keeps today\'s agency behaviour', () => {
    // `!== true`, never `=== false`: a server predating the flag must not have
    // every agency person silently lose their own organisation.
    const u: AffiliationUser = {
      id: ME, account_kind: 'agency', workspaces: [], org: {id: AGENCY, name: 'Meridian'},
    };
    expect(isEnterablePrimaryOrg(u)).toBe(true);
    expect(enterableAffiliations(u).map(w => w.org_id)).toEqual([AGENCY]);
  });

  it('a lapsed employer can be RECONCILED AWAY — it is not exempt from the eject', () => {
    // The un-gated exemption made a dead employer the one context nothing could
    // ever clear, on the one org whose every scoped read is empty.
    const u: AffiliationUser = {
      id: ME, workspaces: [], org: {id: ACME, name: 'Acme'}, org_is_workspace: true,
    };
    expect(isPrimaryOrgContext(u, ACME)).toBe(false);
  });
});

describe('isPrimaryOrgContext — the navigator\'s ejection exemption is CONDITIONAL', () => {
  it('an AGENCY context is kept: that org is never in `workspaces` to begin with', () => {
    const u: AffiliationUser = {
      id: ME, account_kind: 'agency', workspaces: [], org: {id: AGENCY, name: 'Meridian Protective'},
    };
    expect(isPrimaryOrgContext(u, AGENCY)).toBe(true);
  });

  it('a managed CPO\'s `managed_org` is kept too', () => {
    const u: AffiliationUser = {
      id: ME, account_kind: 'cpo', workspaces: [],
      managed_org: {id: AGENCY, name: 'Meridian Protective'},
    };
    expect(isPrimaryOrgContext(u, AGENCY)).toBe(true);
  });

  it('an org the user has SINCE LOST is NOT exempt — it ejects like any other', () => {
    // THE HALF THAT MAKES THIS SAFE. A blanket exemption would keep pointing
    // the surface (and the X-Org-Context header on attendance/incident writes)
    // at a company the person no longer belongs to.
    const lost: AffiliationUser = {id: ME, workspaces: [], org: null, managed_org: null};
    expect(isPrimaryOrgContext(lost, AGENCY)).toBe(false);
    // …and a DIFFERENT agency does not launder it either.
    const elsewhere: AffiliationUser = {id: ME, workspaces: [], org: {id: ACME, name: 'Acme'}};
    expect(isPrimaryOrgContext(elsewhere, AGENCY)).toBe(false);
  });

  it('a missing org id is never exempt', () => {
    expect(isPrimaryOrgContext({id: ME, org: {id: AGENCY, name: 'M'}}, null)).toBe(false);
    expect(isPrimaryOrgContext({id: ME, org: {id: AGENCY, name: 'M'}}, '')).toBe(false);
  });
});

describe('resolveWorkspaceEntry — what happens to a context already set', () => {
  const BOTH: AffiliationUser = {
    id: ME,
    workspaces: [ws(ACME, 'Acme', 'employee'), ws(BOREALIS, 'Borealis', 'manager')],
  };

  it('keeps it, REFRESHED from the live list (a rename, a demotion)', () => {
    const stale = {org_id: BOREALIS, name: 'Borealis Ltd', role: 'owner'} as const;
    expect(resolveWorkspaceEntry(BOTH, stale))
      .toEqual({org_id: BOREALIS, name: 'Borealis', role: 'manager'});
  });

  const GONE = {
    org_id: 'aaaa9999-bbbb-4ccc-8ddd-eeeeffff9999', name: 'Gone', role: 'employee',
  } as const;

  it('F2 — a STALE context with TWO left is KEPT, so the eject card can explain', () => {
    // The two-strike reconcile in DepartmentalNavigator renders the ejection
    // card, and it can only do that while the context is still set. Nulling it
    // here would teleport the user instead of telling them what happened.
    expect(resolveWorkspaceEntry(BOTH, GONE)).toBe(GONE);
  });

  it('F2 — …but the surfaces that never mount that navigator show the PICKER', () => {
    // The standalone DepartmentChannels route, the Vault company shelf and the
    // tab badge would otherwise sit on a dead organisation reading "No channels
    // yet", which is a lie about a company the person is still in.
    expect(needsWorkspaceChoice(BOTH, GONE)).toBe(true);
    expect(needsWorkspaceChoice(BOTH, {org_id: ACME, name: 'Acme', role: 'employee'})).toBe(false);
  });

  it('F2 — a STALE context with exactly ONE left ADOPTS it, no picker', () => {
    // There is no choice to offer and nothing to explain: they have exactly one
    // company to be in, and every scoped read for the other is coming back empty.
    const one: AffiliationUser = {id: ME, workspaces: [ws(ACME, 'Acme', 'employee')]};
    expect(resolveWorkspaceEntry(one, GONE))
      .toEqual({org_id: ACME, name: 'Acme', role: 'employee'});
  });

  it('F2 — a STALE context with NOTHING left resolves to null', () => {
    const none: AffiliationUser = {id: ME, workspaces: []};
    expect(resolveWorkspaceEntry(none, GONE)).toBeNull();
    // …and no picker either: there is nothing to pick.
    expect(needsWorkspaceChoice(none, null)).toBe(false);
  });

  it('F2 — an AGENCY context is never mistaken for stale', () => {
    const agency: AffiliationUser = {
      id: ME, account_kind: 'agency', workspaces: [], org: {id: AGENCY, name: 'Meridian'},
    };
    const ctx = {org_id: AGENCY, name: 'Meridian', role: 'manager'} as const;
    expect(needsWorkspaceChoice(agency, ctx)).toBe(false);
  });

  it('F2 — an OLD server never produces a stale picker either', () => {
    expect(needsWorkspaceChoice({id: ME}, GONE)).toBe(false);
  });

  it('never asks a two-workspace user to re-pick once they have picked', () => {
    const ctx = {org_id: ACME, name: 'Acme', role: 'employee'} as const;
    expect(needsWorkspaceChoice(BOTH, ctx)).toBe(false);
  });
});
