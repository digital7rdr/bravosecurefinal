/**
 * Channels vs2 item 4 — "my shifts" and "my reports" stay CROSS-ORG, labelled.
 *
 * Founder decision 2026-08-12: scoping these four self-read screens is the tidy
 * answer and was rejected, because the workspace context is not persisted — it
 * is gone after every restart, every notification tap, and everywhere in the
 * officer shell. A list scoped against a context that is usually absent becomes
 * "some of my shifts", and a missing attendance record is worse than a
 * confusing extra row. So the data stays and each row names its owner.
 *
 * ⚠️ B-848 (2026-09-11) NARROWED HALF OF THAT PREMISE. A context is no longer
 * "usually absent": `authStore` resolves one on every `/auth/me` that ships
 * `workspaces`, so a single-affiliation person always has one, and a
 * multi-affiliation person picks once per session. What did NOT change is
 * persistence (founder Q3) — it is still session-only, on purpose, because
 * `X-Org-Context` decides where a clock-in and an incident submit LAND.
 *
 * ⚠️ B-856 (2026-09-11) THEN SPLIT THE DECISION BY SHELL, on the founder's ask:
 * _"attendance should show their own channel attendance. if a member belongs to
 * 2 workspaces his attendance should be shown in their individual channel."_
 *
 *   · DEPARTMENTAL shell — always has a context (B-848), so `myShifts` /
 *     `myTodayShift` go out scoped and the labels come off.
 *   · OFFICER shells (agent Attendance, agent dashboard, CPO on-duty home) —
 *     no hub, a context they cannot clear, and scoping them would hide an
 *     officer's own agency shift and disable check-in. They pass
 *     `{crossOrg: true}` and are UNCHANGED, labels included.
 *
 * These pin the three halves that are easy to get wrong: WHEN a label appears
 * (multi-org AND the read could actually be mixed), WHICH shell sends the
 * header, and the clock-out line (always, because it is a state change).
 */
// The module exports a hook alongside the pure helpers, so importing it pulls
// in the auth store and its native dependencies. Mocked so these stay unit
// tests of the two decisions, not an integration test of the store.
jest.mock('@store/authStore', () => ({useAuthStore: jest.fn()}));
// B-856 — the rule now also reads the active workspace, to tell "scoped and the
// server honoured it" from "scoped and an old server answered cross-org".
jest.mock('@store/activeWorkspace', () => ({useActiveWorkspace: jest.fn()}));

import {orgLabelFor, endShiftLabel} from '../crossOrgLabel';

describe('orgLabelFor — the label only earns its place when it disambiguates', () => {
  it('names the organisation for a multi-org person', () => {
    expect(orgLabelFor({org_name: 'Meridian Protective'}, true)).toBe('Meridian Protective');
  });

  it('shows NOTHING for the single-org majority', () => {
    // One employer, one company: repeating its name on every row of a list read
    // daily is pure noise, and noise has a real cost.
    expect(orgLabelFor({org_name: 'Meridian Protective'}, false)).toBeNull();
  });

  it('returns null, not an empty string, when the server sent no name', () => {
    // An older server omits org_name entirely. Null so the caller renders
    // nothing at all rather than an empty chip with padding around it.
    expect(orgLabelFor({org_name: null}, true)).toBeNull();
    expect(orgLabelFor({}, true)).toBeNull();
    expect(orgLabelFor(undefined, true)).toBeNull();
    expect(orgLabelFor({org_name: '   '}, true)).toBeNull();
  });
});

describe('endShiftLabel — the clock-out always says what it will end', () => {
  it('names the organisation and the site', () => {
    /**
     * The one case in this decision with a functional consequence. The
     * open-session uniqueness rule is per PERSON, not per organisation, so from
     * inside Acme this button can legitimately close a Meridian shift. That is
     * correct — one body, one shift — but nothing on screen said which.
     */
    expect(endShiftLabel({org_name: 'Meridian Protective', site_label: 'Gate B'}))
      .toBe('End shift — Meridian Protective · Gate B');
  });

  it('degrades cleanly when only one of the two is known', () => {
    expect(endShiftLabel({org_name: 'Meridian Protective', site_label: null}))
      .toBe('End shift — Meridian Protective');
    expect(endShiftLabel({site_label: 'Gate B'})).toBe('End shift — Gate B');
  });

  it('never renders a dangling separator when nothing is known', () => {
    // A legacy clock-in has no assigned shift at all, so this must still be a
    // usable button rather than "End shift — ".
    expect(endShiftLabel(null)).toBe('End shift');
    expect(endShiftLabel(undefined)).toBe('End shift');
    expect(endShiftLabel({org_name: '  ', site_label: ''})).toBe('End shift');
  });

  it('is NOT gated on multi-org — a single-org person still gets the name', () => {
    /**
     * Deliberate asymmetry with the list labels: naming a state change is worth
     * a string even for someone with one employer; repeating their company on
     * fifty list rows is not.
     *
     * Asserted on BEHAVIOUR. The first version checked `endShiftLabel.length`,
     * which is vacuous — JS omits defaulted parameters from `Function.length`,
     * so `endShiftLabel(shift, show = true)` — the most likely way someone
     * would gate it — still reports 1 and the test passes.
     */
    expect(endShiftLabel({org_name: 'Meridian'})).toBe('End shift — Meridian');
  });

  it('truncates rather than overflowing the fixed-height button', () => {
    // The button is a 56dp row; both halves are free text with no length limit
    // in the schema. Clipping here keeps every caller safe.
    const long = endShiftLabel({
      org_name: 'Meridian Protective Services International',
      site_label: 'North Gate Vehicle Screening Point',
    });
    expect(long.startsWith('End shift — ')).toBe(true);
    expect(long.length).toBeLessThanOrEqual('End shift — '.length + 28);
    expect(long.endsWith('…')).toBe(true);
  });
});

type Scope = {
  scoped: boolean;
  rows?: ReadonlyArray<{org_user_id?: string | null; org_name?: string | null}> | null;
};

describe('useShowOrgLabels — who counts as multi-org', () => {
  /**
   * The hook is two selectors and one rule, and the rule is the whole decision:
   * get it wrong and either everyone sees redundant labels or the consultant
   * sees none. Both stores are mocked so the REAL selectors run against a fake
   * state — a unit test of the rule, not an integration test of zustand.
   */

  const {useAuthStore} = require('@store/authStore') as {useAuthStore: jest.Mock};
  const {useActiveWorkspace} = require('@store/activeWorkspace') as {useActiveWorkspace: jest.Mock};

  const {useShowOrgLabels} = require('../crossOrgLabel') as {
    useShowOrgLabels: (scope?: Scope) => boolean;
  };

  // Named useDecide so the rules-of-hooks lint accepts the call inside it.
  // It is not a component; the store hooks are plain mocks here.
  const useDecide = (user: unknown, scope?: Scope, workspace: unknown = null): boolean => {
    useAuthStore.mockImplementation((sel: (s: unknown) => boolean) => sel({user}));
    useActiveWorkspace.mockImplementation((sel: (s: unknown) => unknown) => sel({workspace}));
    return useShowOrgLabels(scope);
  };

  it('is false for one workspace and nothing else', () => {
    expect(useDecide({workspaces: [{org_id: 'acme'}]})).toBe(false);
  });

  it('is false for an agency officer with no workspace', () => {
    expect(useDecide({org: {id: 'meridian'}, workspaces: []})).toBe(false);
  });

  it('is TRUE for the consultant — an agency plus a workspace', () => {
    /**
     * THE persona this whole decision exists for. `workspaces` never contains
     * the agency (an agency roster is not an enterable workspace tile), so
     * counting only that array would have read "one organisation" for the one
     * person whose list is actually mixed — the labels would be absent for
     * exactly the user who needs them.
     */
    expect(useDecide({org: {id: 'meridian'}, workspaces: [{org_id: 'acme'}]})).toBe(true);
  });

  it('is TRUE for a manager of an AGENCY plus a workspace', () => {
    /**
     * `workspaces` INNER JOINs `org_workspaces`, so an agency membership is
     * structurally absent from it — correct for the hub, where an agency roster
     * is not an enterable tile, and wrong for counting. `managed_org` is the
     * fact that exists for exactly this, and omitting it made a manager of two
     * agencies read as ONE organisation.
     */
    expect(useDecide({managed_org: {id: 'meridian'}, workspaces: [{org_id: 'acme'}]})).toBe(true);
  });

  it('is TRUE for a company agent who joined another workspace', () => {
    /**
     * The B-417 persona. An agency's own account IS its org — its user id is
     * the org id — so nothing in `org` or `workspaces` names it once the
     * discriminator has resolved to the joined workspace instead. Inferring
     * that identity from a proxy rather than reading `owns_agency` is the
     * mistake B-417 shipped; dropping the flag repeats it.
     */
    expect(useDecide({
      id: 'agency-1', owns_agency: true, workspaces: [{org_id: 'acme'}],
    })).toBe(true);
  });

  it('does not count an agency that is ALSO the primary org twice', () => {
    expect(useDecide({id: 'agency-1', owns_agency: true, org: {id: 'agency-1'}})).toBe(false);
  });

  it('is TRUE for two workspaces', () => {
    expect(useDecide({workspaces: [{org_id: 'acme'}, {org_id: 'borealis'}]})).toBe(true);
  });

  it('does not double-count one org that appears in both places', () => {
    // A workspace owner's primary org IS their workspace, so the same id
    // arrives twice — that is one organisation, not two.
    expect(useDecide({org: {id: 'acme'}, workspaces: [{org_id: 'acme'}]})).toBe(false);
  });

  it('is false for a user with nothing, and for no user at all', () => {
    expect(useDecide({})).toBe(false);
    expect(useDecide(null)).toBe(false);
  });
});

describe('useShowOrgLabels — B-856, a SCOPED read has nothing left to disambiguate', () => {
  const {useAuthStore} = require('@store/authStore') as {useAuthStore: jest.Mock};
  const {useActiveWorkspace} = require('@store/activeWorkspace') as {useActiveWorkspace: jest.Mock};
  const {useShowOrgLabels} = require('../crossOrgLabel') as {
    useShowOrgLabels: (scope?: Scope) => boolean;
  };

  // The consultant: an agency AND a workspace — the only persona that ever
  // sees labels, so every case below starts from "labels would otherwise show".
  const CONSULTANT = {org: {id: 'meridian'}, workspaces: [{org_id: 'acme'}]};
  const ACME = {org_id: 'acme', name: 'Acme Holdings', role: 'employee'};

  const useDecide = (scope?: Scope, workspace: unknown = ACME): boolean => {
    useAuthStore.mockImplementation((sel: (s: unknown) => boolean) => sel({user: CONSULTANT}));
    useActiveWorkspace.mockImplementation((sel: (s: unknown) => unknown) => sel({workspace}));
    return useShowOrgLabels(scope);
  };

  it('UNSCOPED (the officer shells) is unchanged — the consultant still gets labels', () => {
    expect(useDecide()).toBe(true);
    expect(useDecide({scoped: false, rows: [{org_name: 'Acme Holdings'}]})).toBe(true);
  });

  it('SCOPED and every row belongs to the active workspace → no labels', () => {
    expect(useDecide({scoped: true, rows: [{org_user_id: 'acme'}, {org_user_id: 'acme'}]}))
      .toBe(false);
    // An empty list, and rows an older server sent with neither id nor name,
    // cannot be labelled anyway — hiding is the honest answer, not a guess.
    expect(useDecide({scoped: true, rows: []})).toBe(false);
    expect(useDecide({scoped: true, rows: [{org_name: null}, {}]})).toBe(false);
  });

  it('SCOPED but a row belongs to a DIFFERENT organisation → labels, because the scope did not take', () => {
    // The undeployed-server case. Without this the app would render a merged
    // list with nothing saying which company each row belongs to — strictly
    // worse than the behaviour it replaced.
    expect(useDecide({scoped: true, rows: [{org_user_id: 'acme'}, {org_user_id: 'meridian'}]}))
      .toBe(true);
  });

  /**
   * P2-3 — ID FIRST. Names are not identifiers.
   *
   * The first cut compared `org_name` alone, so two organisations that happen
   * to share a display name produced a genuinely cross-org list that the rule
   * declared single-org and rendered with NO labels — the exact ambiguity the
   * labels exist to remove, in the one case where it matters most.
   */
  it('keys on org_user_id, so two orgs sharing a NAME are still labelled', () => {
    expect(useDecide({scoped: true, rows: [
      {org_user_id: 'acme', org_name: 'Meridian'},
      {org_user_id: 'meridian', org_name: 'Meridian'},
    ]})).toBe(true);
    // …and the id wins over a name that would have said "same": a row whose id
    // matches the active workspace is NOT foreign just because it is unnamed or
    // renamed.
    expect(useDecide({scoped: true, rows: [{org_user_id: 'acme', org_name: 'Acme (renamed)'}]}))
      .toBe(false);
  });

  it('falls back to the NAME only for a row with no id (an older server)', () => {
    expect(useDecide({scoped: true, rows: [{org_name: 'Acme Holdings'}]})).toBe(false);
    expect(useDecide({scoped: true, rows: [{org_name: 'Meridian Protective'}]})).toBe(true);
    // A mixed response: one modern row, one legacy row, both this workspace.
    expect(useDecide({scoped: true, rows: [{org_user_id: 'acme'}, {org_name: 'Acme Holdings'}]}))
      .toBe(false);
  });

  it('SCOPED with no active workspace → labels (no header was actually sent)', () => {
    expect(useDecide({scoped: true, rows: [{org_user_id: 'acme'}]}, null)).toBe(true);
  });

  it('a single-org person never sees labels, scoped or not', () => {
    useAuthStore.mockImplementation((sel: (s: unknown) => boolean) => sel({user: {workspaces: [{org_id: 'acme'}]}}));
    useActiveWorkspace.mockImplementation((sel: (s: unknown) => unknown) => sel({workspace: ACME}));
    expect(useShowOrgLabels()).toBe(false);
    expect(useShowOrgLabels({scoped: true, rows: [{org_user_id: 'meridian'}]})).toBe(false);
  });
});

describe('B-856 — which shell sends the org context, by persona', () => {
  const {readFileSync} = require('fs') as typeof import('fs');
  const {join} = require('path') as typeof import('path');

  const code = (rel: string): string =>
    readFileSync(join(process.cwd(), rel), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  /**
   * The rule is not "scope attendance"; it is "scope it where the user can
   * CHOOSE the workspace". Three personas, and the middle one is the P0 the
   * critic caught: an agency-only CPO who once opened a customer's workspace
   * carries that context forever (there is no hub in the officer shell to clear
   * it), so a scoped `my-shift/today` there returns null and check-in dies.
   */
  /**
   * The READS and the WRITES. Widened to `clockIn`/`clockOut` after the critic
   * round: the header does not merely filter a list, it decides which
   * organisation a check-in LANDS in — so a sticky customer workspace on the
   * officer shell would file an agency officer's shift in the customer's
   * attendance book, which no read-side fix can undo.
   */
  const ATTENDANCE_CALLS = /attendanceApi\.(myShifts|myTodayShift|clockIn|clockOut)\([^)]*\)/g;

  it('the OFFICER-ONLY shells opt out with {crossOrg: true}, reads AND writes', () => {
    for (const rel of [
      'src/screens/agent/AgentDashboardScreen.tsx',
      'src/screens/cpo/OnDutyHomeScreen.tsx',
    ]) {
      const src = code(rel);
      const calls = src.match(ATTENDANCE_CALLS) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {expect(call).toContain('crossOrg: true');}
    }
  });

  /**
   * D1 (B-856 A4) — `agent/AttendanceScreen` is mounted in BOTH shells.
   *
   * `DepartmentalNavigator` uses it as the member's `Attendance` route, so a
   * blanket `{crossOrg: true}` showed a QA Delta session to somebody standing
   * inside QA Echo — the server was answering `[]` for Echo the whole time.
   * The flag therefore follows the SHELL, and the rule the officer shells rely
   * on is unchanged: no workspace context, no scoping.
   *
   * The WRITES stay cross-org. A write decides which organisation a record
   * LANDS in, and in the Departmental shell the verified flow
   * (`VerifyAttendanceScreen`) already owns check-in and sends the header —
   * the legacy buttons here only render when the server has v2 gated OFF,
   * which is the officer case.
   */
  it('the DUAL-SHELL attendance screen scopes by shell, and only the reads', () => {
    const src = code('src/screens/agent/AttendanceScreen.tsx');
    // The decision site, not merely the presence of the words.
    expect(src).toMatch(/const inDepartmentalShell = useInDepartmentalShell\(\);/);
    expect(src).toMatch(/const activeOrgId = activeWorkspace\?\.org_id \?\? null;/);
    expect(src).toMatch(
      /const scoped = inDepartmentalShell && activeOrgId !== null;/);
    // Reads follow the shell…
    expect(src).toMatch(/attendanceApi\.myShifts\(\{crossOrg: !scoped\}\)/);
    expect(src).toMatch(/attendanceApi\.myTodayShift\(\{crossOrg: !scoped\}\)/);
    // …writes do not.
    expect(src).toMatch(/attendanceApi\.clockIn\([^)]*\{crossOrg: true\}\)/);
    expect(src).toMatch(/attendanceApi\.clockOut\([^)]*\{crossOrg: true\}\)/);
    // The one cross-org read that remains is the NOTICE probe, and it may
    // never reach `shifts` — that is what put another org's row on screen.
    expect(src).toMatch(/setForeignOpen\(data\.find\(/);
    expect(src).not.toMatch(/setShifts\(data\);[\s\S]{0,80}crossOrg: true/);
  });

  it('the DEPARTMENTAL shell sends the header (no opt-out) — the founder ask', () => {
    for (const rel of [
      'src/screens/deptchat/MyAttendanceScreen.tsx',
      'src/screens/deptchat/DepartmentalHomeScreen.tsx',
      // The verified check-in flow: here the workspace the user ENTERED is the
      // employer they are clocking into, so the header is exactly right.
      'src/screens/deptchat/VerifyAttendanceScreen.tsx',
    ]) {
      const src = code(rel);
      const calls = src.match(ATTENDANCE_CALLS) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {expect(call).not.toContain('crossOrg');}
    }
  });

  /**
   * P2-4 — caller-completeness on the shared hook.
   *
   * `/incidents/mine` has been on `ORG_SCOPED_PREFIXES` all along, so that read
   * ALREADY carried the active workspace; only the labels had not caught up and
   * were still answering "multi-org person → always label" off the bare hook.
   * Every screen that renders a SCOPED self-read says so.
   */
  it('every scoped self-read screen passes {scoped, rows} — not the bare hook', () => {
    for (const [rel, rowsVar] of [
      ['src/screens/deptchat/MyAttendanceScreen.tsx', 'shifts'],
      ['src/screens/deptchat/MyIncidentsScreen.tsx', 'reports'],
    ] as const) {
      expect(code(rel)).toContain(`useShowOrgLabels({scoped: true, rows: ${rowsVar}})`);
    }
    // D1 — the dual-shell screen passes the RUNTIME flag, because its read is
    // scoped in one shell and not the other. `scoped: false` reproduces the
    // officer behaviour exactly (the hook falls through to "multi-org → label").
    expect(code('src/screens/agent/AttendanceScreen.tsx'))
      .toContain('useShowOrgLabels({scoped, rows: shifts})');
    // The officer-ONLY shell keeps the bare hook — its read is always cross-org.
    expect(code('src/screens/cpo/OnDutyHomeScreen.tsx')).toContain('useShowOrgLabels()');
  });

  it('the Departmental list passes its ROWS to the label rule, not just `scoped`', () => {
    // Half the rule is the response check; a caller that omits `rows` hides the
    // labels on a merged list the moment a server lags the app.
    expect(code('src/screens/deptchat/MyAttendanceScreen.tsx'))
      .toMatch(/useShowOrgLabels\(\{scoped: true, rows: shifts\}\)/);
  });

  it('endShiftLabel stays UNCONDITIONAL — clockOut is still person-scoped', () => {
    // One open session per PERSON across all organisations, so from inside Acme
    // this button can still close a Meridian shift. Scoping the LIST does not
    // change that, and the button must keep naming what it will end.
    const src = code('src/screens/deptchat/crossOrgLabel.ts');
    const start = src.indexOf('export function endShiftLabel');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start);
    expect(body).not.toContain('scoped');
    expect(body).not.toContain('useShowOrgLabels');
  });
});

describe('every cross-org list actually adopted the helper', () => {
  /**
   * "One helper, not five inline checks" is only true if all five USE it, and
   * nothing made that so — two lists shipped unlabelled, one of them thirty
   * lines above an edit in the same file. That is the repo's duplicate-copy
   * class arriving by omission rather than by copy-paste, and per the standing
   * rule the guard has to be a source scan: a unit test cannot see copy N+1.
   *
   * Derived from the CALLERS of the two cross-org endpoints, not from a
   * hand-listed set — a new screen that reads `myShifts` is caught the day it
   * is written.
   */

  const {readFileSync, existsSync} = require('fs') as typeof import('fs');

  const {execSync} = require('child_process') as typeof import('child_process');

  // `git ls-files` lists the INDEX, but the scan below reads from DISK. A screen
  // deleted in the working tree and not yet staged is still indexed, so an
  // unfiltered list throws ENOENT and the failure reads as a cross-org
  // regression rather than "you deleted a screen". Filter to what exists.
  const files = execSync('git ls-files "src/screens/**/*.tsx"', {encoding: 'utf8'})
    .split(/\r?\n/).filter(Boolean).filter(existsSync);

  it('every screen rendering myShifts or incidents.mine rows labels them', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const code = readFileSync(f, 'utf8').split(/\r?\n/).filter(l => {
        const t = l.trim();
        return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      }).join('\n');

      // Reads a cross-org list...
      const readsList = /attendanceApi\.myShifts\(|incidentApi\.mine\(/.test(code);
      if (!readsList) {continue;}
      // ...and renders per-row JSX from it (a screen that only counts rows, or
      // derives a single status, is not a list and is out of scope).
      const rendersRows = /\bshifts\b[\s\S]{0,40}?\.map\(|\brows\b[\s\S]{0,40}?\.map\(|\bdata\b[\s\S]{0,40}?\.map\(/.test(code);
      if (!rendersRows) {continue;}

      if (!/orgLabelFor\(/.test(code)) {offenders.push(f);}
    }
    expect(offenders).toEqual([]);
  });

  /**
   * ⚠️ WHAT THIS SCAN DOES NOT CATCH, stated so nobody trusts it further than
   * it goes: it proves each qualifying screen REFERENCES `orgLabelFor`, not
   * that the reference is live. Wrapping the call in `{false ? … : null}`
   * leaves the token present and the scan green — the "a token exists somewhere
   * in the file" weakness this repo has been bitten by before.
   *
   * It is still the right gate for the failure that actually happened — two
   * screens that never adopted the helper at all — and deliberately disabling a
   * call is a different, louder kind of change. The label LOGIC is covered by
   * the unit tests above; only its wiring rests on this.
   */

  it('...and the scan is not vacuous — it finds the screens it is meant to check', () => {
    // If the detector ever stops matching, the assertion above passes over an
    // empty set and guards nothing. Pin that it sees a real population.
    const seen = files.filter(f => /attendanceApi\.myShifts\(|incidentApi\.mine\(/
      .test(readFileSync(f, 'utf8')));
    expect(seen.length).toBeGreaterThanOrEqual(4);
  });
});
