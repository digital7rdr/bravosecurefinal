/**
 * Channels vs2 edge A1/A2 — a wake that names an organisation must point the
 * workspace surface at it BEFORE the tap navigates.
 *
 * THE BUG: a manager of two orgs taps "Acme: incident reported" and reads the
 * incident with Borealis stamped on the request (`X-Org-Context` is sticky and
 * session-only, so null at boot); the server's `WHERE id = $1 AND org_user_id =
 * $2` finds nothing and the screen swallows it into an empty state.
 *
 * The security half is pinned as hard as the feature half: this function must
 * NEVER adopt an org the user does not already hold, because that is the only
 * thing standing between a forged push blob and the UI asking for another
 * tenant's data. (The server refuses it too — the header narrows, never grants
 * — but a client that asks is a client one server bug away from getting it.)
 *
 * B-848 changed two things here, and the prose above used to contradict both.
 * The membership check reads `enterableAffiliations` — the same predicate the
 * Workspace Hub and the entry resolver use, which also covers the caller's
 * primary/managed org (an agency org is structurally absent from `workspaces`,
 * so a wake naming the caller's OWN agency used to be rejected). And a refusal
 * is no longer silent: `'refused'` is split out of `'skipped'`, and it DROPS a
 * context that names a different organisation rather than leaving the surface
 * claiming org A while the user acts on org B.
 */
import {useActiveWorkspace, getActiveWorkspace} from '../activeWorkspace';

type Membership = {org_id: string; name: string; role: 'owner' | 'manager' | 'employee' | 'cpo'};

let mockWorkspaces: Membership[] | undefined;
// B-848 — the membership check reads ENTERABLE AFFILIATIONS now (the workspace
// rows PLUS the primary/managed org, which are structurally absent from that
// array), so the fixture has to be able to carry one.
let mockOrg: {id: string; name: string} | null = null;
jest.mock('@/store/authStore', () => ({
  useAuthStore: {getState: () => ({user: {id: 'me', workspaces: mockWorkspaces, org: mockOrg}})},
}));

// LETTER-BEARING on purpose. The first version used all-digit uuids, which made
// the case-handling test below assert nothing at all: `.toUpperCase()` on
// '1111-…' is the identity function, so it "passed" while the code actually
// validated case-insensitively and then compared case-SENSITIVELY.
const ACME     = 'aaaa1111-bbbb-4ccc-8ddd-eeeeffff0001';
const BOREALIS = 'aaaa2222-bbbb-4ccc-8ddd-eeeeffff0002';
const STRANGER = 'aaaa3333-bbbb-4ccc-8ddd-eeeeffff0003';

const BOTH: Membership[] = [
  {org_id: ACME,     name: 'Acme',     role: 'manager'},
  {org_id: BOREALIS, name: 'Borealis', role: 'owner'},
];

// Imported after the mock is registered; the module `require`s authStore lazily.
const adopt = (id: unknown) =>
  (require('../adoptOrgContext') as typeof import('../adoptOrgContext'))
    .adoptOrgContextFromWake(id);

beforeEach(() => {
  mockWorkspaces = BOTH;
  mockOrg = null;
  useActiveWorkspace.getState().setActiveWorkspace(null);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

describe('adoptOrgContextFromWake — the feature half', () => {
  it('adopts the org the wake names, with that org\'s OWN role', async () => {
    // The role matters: `contextManagerRole` renders manager chrome from it, so
    // adopting Borealis with Acme's role would show the wrong surface.
    expect(await adopt(BOREALIS)).toBe('adopted');
    expect(getActiveWorkspace()).toEqual({org_id: BOREALIS, name: 'Borealis', role: 'owner'});
  });

  it('switches AWAY from a sticky context pointing at the other org (the A1 bug)', async () => {
    useActiveWorkspace.getState().setActiveWorkspace({org_id: ACME, name: 'Acme', role: 'manager'});
    expect(await adopt(BOREALIS)).toBe('adopted');
    expect(getActiveWorkspace()?.org_id).toBe(BOREALIS);
  });

  it('reports `unchanged` — and writes nothing — when already on that org', async () => {
    useActiveWorkspace.getState().setActiveWorkspace({org_id: ACME, name: 'Acme', role: 'manager'});
    const before = getActiveWorkspace();
    expect(await adopt(ACME)).toBe('unchanged');
    // Same OBJECT: a needless write re-renders every context consumer and, on a
    // real org change, costs a navigator-free frame (B-95).
    expect(getActiveWorkspace()).toBe(before);
  });
});

describe('adoptOrgContextFromWake — the safety half', () => {
  /**
   * ⚠️ B-848 RE-POINTED THE NEXT TWO. They used to expect `'skipped'` AND an
   * untouched context; both halves changed, and for the same reason.
   *
   * `'skipped'` conflated "the blob named no org" — every old server, every
   * single-org user, and a state that must leave a sticky context alone — with
   * "the blob named an org we refuse", which is a statement that the wake is
   * about a DIFFERENT company from the one the surface is pointed at. Keeping
   * the old context there means the user reads org B's notification with org A
   * stamped on every request, and `X-Org-Context` decides where a clock-in and
   * an incident submit LAND. So the refusal now DROPS the foreign context and
   * reports `'refused'`.
   */
  it('REFUSES an org the user does not hold — and drops a context naming another', async () => {
    useActiveWorkspace.getState().setActiveWorkspace({org_id: ACME, name: 'Acme', role: 'manager'});
    expect(await adopt(STRANGER)).toBe('refused');
    // Not switched to the stranger — released. Client-side adoption can never
    // widen access, and this is the half that keeps it from narrowing it wrong.
    expect(getActiveWorkspace()).toBeNull();
  });

  it('refuses when the membership list is UNKNOWN (old server / /auth/me not landed)', async () => {
    // Undefined must read as "cannot vouch", not as "no restrictions" — the
    // fail-open reading is how a boot race would adopt anything it was handed.
    mockWorkspaces = undefined;
    expect(await adopt(ACME)).toBe('refused');
    expect(getActiveWorkspace()).toBeNull();
  });

  it('a refusal with NO context set writes nothing at all', async () => {
    expect(getActiveWorkspace()).toBeNull();
    expect(await adopt(STRANGER)).toBe('refused');
    expect(getActiveWorkspace()).toBeNull();
  });

  it.each([
    ['absent (old server)', undefined],
    ['null',               null],
    ['empty',              ''],
    ['not a uuid',         'acme'],
    ['36 hyphens',         '------------------------------------'],
    ['a non-string',       {org_id: ACME}],
  ])('skips a %s org id', async (_label, value) => {
    expect(await adopt(value)).toBe('skipped');
    expect(getActiveWorkspace()).toBeNull();
  });

  it('accepts the SAME id shape the server header validator accepts', async () => {
    // `readOrgContextHeader` rejects anything but 8-4-4-4-12, so a client that
    // adopted a looser shape would set a context the server silently drops —
    // the failure would look exactly like the bug we just fixed.
    const SERVER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(SERVER_RE.test(ACME)).toBe(true);
    expect(await adopt(ACME)).toBe('adopted');
  });

  it('NORMALISES case — an upper-case id adopts, it does not silently skip', async () => {
    // The trap: validate with /i, then compare with === against ids Postgres
    // always emits lowercase. The id passes the gate and then reports `skipped`,
    // which is indistinguishable from "not a member" in a device log.
    expect(ACME).not.toBe(ACME.toUpperCase());   // the previous fixture failed HERE
    expect(await adopt(ACME.toUpperCase())).toBe('adopted');
    // Stored canonically — from the membership row, never the wake's spelling.
    expect(getActiveWorkspace()?.org_id).toBe(ACME);
  });

  it('treats an upper-case id as ALREADY ACTIVE, rather than re-writing it', async () => {
    useActiveWorkspace.getState().setActiveWorkspace({org_id: ACME, name: 'Acme', role: 'manager'});
    expect(await adopt(ACME.toUpperCase())).toBe('unchanged');
  });
});

describe('adoptOrgContextFromWake — two taps in the settle window', () => {
  it('the LATER tap wins, and the earlier one reports `superseded`', async () => {
    // Bell rows have no tap guard and the adopt awaits, so this is a
    // double-tap away: chain 1 would wake holding chain 2's context and
    // deep-link its own record against the wrong org.
    const first  = adopt(ACME);
    const second = adopt(BOREALIS);
    expect(await first).toBe('superseded');
    expect(await second).toBe('adopted');
    expect(getActiveWorkspace()?.org_id).toBe(BOREALIS);
  });

  it('a fast SKIP still supersedes an in-flight adoption', async () => {
    // A tap on a row with no orgId resolves instantly. It must still invalidate
    // a settling chain, or the stale chain navigates on top of the newer tap.
    const first = adopt(ACME);
    expect(await adopt(undefined)).toBe('skipped');
    expect(await first).toBe('superseded');
  });

  it('a single tap is never superseded by itself', async () => {
    expect(await adopt(BOREALIS)).toBe('adopted');
  });
});

describe('adoptOrgContextFromWake — ordering contract', () => {
  it('an adopted switch RESOLVES AFTER the context is already written', async () => {
    // Callers navigate on the line after `await`. If the write happened in the
    // continuation, the deep link would fetch with the old org still stamped.
    const p = adopt(BOREALIS);
    expect(getActiveWorkspace()?.org_id).toBe(BOREALIS);
    await p;
  });

  it('waits out the navigator-free frame before resolving (B-95)', async () => {
    // `DepartmentalNavigator` unmounts its tree for ~30ms on an org change;
    // navigating into that gap targets a navigator that is not there.
    const t0 = Date.now();
    await adopt(BOREALIS);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });

  it('does NOT make the caller wait when nothing changed', async () => {
    const t0 = Date.now();
    await adopt(STRANGER);
    expect(Date.now() - t0).toBeLessThan(60);
  });
});

describe('B-848 — the predicate is the same one the hub enters by', () => {
  it('adopts the caller\'s own AGENCY, which is never in `workspaces`', async () => {
    // WORKSPACE_AFFILIATIONS_SQL inner-joins org_workspaces, so an agency org
    // is structurally absent from that array. Reading it directly refused a
    // wake naming the user's OWN company, and the "not a membership" warn made
    // that look like a bug in the feature rather than in the predicate.
    mockWorkspaces = [];
    mockOrg = {id: STRANGER, name: 'Meridian Protective'};
    expect(await adopt(STRANGER)).toBe('adopted');
    expect(getActiveWorkspace())
      .toEqual({org_id: STRANGER, name: 'Meridian Protective', role: 'employee'});
  });

  it('an OLD server still vouches for nothing, org or no org', async () => {
    mockWorkspaces = undefined;
    mockOrg = {id: STRANGER, name: 'Meridian Protective'};
    expect(await adopt(STRANGER)).toBe('refused');
    expect(getActiveWorkspace()).toBeNull();
  });
});

describe('releaseOrgContextForUnknownWake — a directory wake that names no org', () => {
  const release = () =>
    (require('../adoptOrgContext') as typeof import('../adoptOrgContext'))
      .releaseOrgContextForUnknownWake();

  it('drops a context rather than scoping the directory to the wrong company', async () => {
    // The conversation→org registry is empty after a 403 or an offline cold
    // boot. Opening the directory under the sticky context shows a channel list
    // that does not contain the channel the user just tapped.
    useActiveWorkspace.getState().setActiveWorkspace({org_id: ACME, name: 'Acme', role: 'manager'});
    expect(release()).toBe(true);
    expect(getActiveWorkspace()).toBeNull();
  });

  it('F5 — a SINGLE-affiliation user KEEPS theirs: it is the only answer there is', () => {
    // Their context is not a guess — it is resolved from the server's own list
    // on every /auth/me. Releasing it because a local registry was cold trades a
    // correct scope for an unscoped directory, and the picker cannot help them
    // either (it needs two options). A pure downgrade.
    mockWorkspaces = [{org_id: ACME, name: 'Acme', role: 'manager'}];
    useActiveWorkspace.getState().setActiveWorkspace({org_id: ACME, name: 'Acme', role: 'manager'});
    expect(release()).toBe(false);
    expect(getActiveWorkspace()?.org_id).toBe(ACME);
  });

  it('F5 — an OLD server (no affiliation list) keeps its context too', () => {
    mockWorkspaces = undefined;
    useActiveWorkspace.getState().setActiveWorkspace({org_id: ACME, name: 'Acme', role: 'manager'});
    expect(release()).toBe(false);
    expect(getActiveWorkspace()?.org_id).toBe(ACME);
  });

  it('is a no-op when there was nothing to release', () => {
    expect(release()).toBe(false);
    expect(getActiveWorkspace()).toBeNull();
  });
});
