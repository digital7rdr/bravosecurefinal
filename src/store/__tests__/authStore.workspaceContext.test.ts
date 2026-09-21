/**
 * B-848 — `/auth/me` is where the workspace context is decided.
 *
 * A null context used to mean "every organisation" on the Departmental
 * surface: both scoping belts are fail-open, so the Channels directory
 * answered with every company the caller holds a membership in. Only a
 * Workspace Hub tile ever wrote a context, so a cold boot, a drawer tap, a CPO
 * tab or a notification landed on the mixed list.
 *
 * The resolver runs HERE and not in a navigator effect, because a navigator
 * effect runs AFTER its child's first focus fetch — and three scoped readers
 * (the standalone `DepartmentChannels` route, the Vault company shelf and
 * `useDeptUnread` in `CpoTabs`) never mount that navigator at all.
 *
 * Same harness as `authStore.recheckMembership.test.ts`: the REAL store logic
 * with the API layer mocked, and the REAL `activeWorkspace` store so the write
 * is observed rather than asserted against a spy that cannot see a no-op.
 */
jest.mock('@services/api', () => ({
  authApi: {me: jest.fn(), refresh: jest.fn(() => Promise.resolve())},
  agentApi: {setDuty: jest.fn(() => Promise.resolve())},
  getDeviceId: jest.fn(() => Promise.resolve('dev-1')),
  tokenStore: {
    get: jest.fn(), getRefresh: jest.fn(() => Promise.resolve('refresh-token')),
    set: jest.fn(), clear: jest.fn(),
  },
  subscriptionApi: {},
}));
jest.mock('@modules/observability', () => ({setUser: jest.fn()}));
// The optimistic-boot lane reads a persisted user snapshot; same rig as
// `authStore.initialize.test.ts`.
const asyncStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => asyncStore[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => { asyncStore[k] = v; }),
    removeItem: jest.fn(async (k: string) => { delete asyncStore[k]; }),
    multiSet: jest.fn(async () => {}),
    multiRemove: jest.fn(async () => {}),
  },
}));
// F3 — the biometric lane is one of the four `/auth/me` doors, so it needs a
// real-shaped module rather than the `{}` the other store suites get away with.
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(() => Promise.resolve(true)),
  isEnrolledAsync: jest.fn(() => Promise.resolve(true)),
  authenticateAsync: jest.fn(() => Promise.resolve({success: true})),
}));

import {useAuthStore} from '@store/authStore';
import {getActiveWorkspace, useActiveWorkspace} from '@store/activeWorkspace';
import {authApi, tokenStore} from '@services/api';

const mockMe = authApi.me as jest.Mock;
const mockSignOut = jest.fn(() => Promise.resolve());

const SNAPSHOT_KEY = 'auth:user_snapshot';
const SNAPSHOT_USER = {
  id: 'u1', email: 'member@x.io', full_name: 'Member One', role: 'individual',
  subscription_tier: 'enterprise', must_set_password: false,
  cpo_needs_onboarding: false, auto_dispatch_enabled: false,
};
// A real-shaped access token — only the payload segment is ever read.
const b64url = (o: unknown): string =>
  Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
const JWT = `hdr.${b64url({sub: 'u1', role: 'individual', device_id: 'dev-1', exp: 9999999999})}.sig`;

const ACME = 'aaaa1111-bbbb-4ccc-8ddd-eeeeffff0001';
const BOREALIS = 'aaaa2222-bbbb-4ccc-8ddd-eeeeffff0002';

const API_USER = {
  id: 'u1', email: 'member@x.io', display_name: 'Member One', role: 'individual',
  subscription_tier: 'enterprise', phone_e164: '+10000000000',
};

function meReturns(extra: Record<string, unknown>, user: Record<string, unknown> = API_USER) {
  mockMe.mockResolvedValueOnce({
    user, account_kind: 'individual', must_set_password: false,
    membership_status: null, ...extra,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(asyncStore)) {delete asyncStore[k];}
  (tokenStore.getRefresh as jest.Mock).mockResolvedValue('refresh-token');
  useAuthStore.setState({
    accessEnded: false, user: null, isAuthenticated: true, isSigningOut: false,
    signOut: mockSignOut,
  });
  useActiveWorkspace.getState().setActiveWorkspace(null);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

describe('a /auth/me that names exactly ONE enterable organisation enters it', () => {
  it('sets the context from the single workspace row', async () => {
    meReturns({workspaces: [{org_id: ACME, name: 'Acme', role: 'employee'}], org: {id: ACME, name: 'Acme'}});
    await useAuthStore.getState().recheckMembership();
    expect(getActiveWorkspace()).toEqual({org_id: ACME, name: 'Acme', role: 'employee'});
  });

  it('the duplicate `org` row does not make a one-workspace user look like two', async () => {
    // Arms 2/4 of the primary-org precedence put the SAME org in both fields.
    meReturns({workspaces: [{org_id: ACME, name: 'Acme', role: 'manager'}], org: {id: ACME, name: 'Acme'}});
    await useAuthStore.getState().recheckMembership();
    expect(getActiveWorkspace()?.org_id).toBe(ACME);
  });
});

describe('a /auth/me that names TWO leaves the choice to the user', () => {
  it('writes NOTHING — the surfaces render the picker gate instead', async () => {
    meReturns({workspaces: [
      {org_id: ACME, name: 'Acme', role: 'employee'},
      {org_id: BOREALIS, name: 'Borealis', role: 'manager'},
    ]});
    await useAuthStore.getState().recheckMembership();
    expect(getActiveWorkspace()).toBeNull();
  });

  it('a context the user already picked is KEPT, refreshed from the live list', async () => {
    useActiveWorkspace.getState().setActiveWorkspace({org_id: BOREALIS, name: 'Borealis Ltd', role: 'owner'});
    meReturns({workspaces: [
      {org_id: ACME, name: 'Acme', role: 'employee'},
      {org_id: BOREALIS, name: 'Borealis', role: 'manager'},
    ]});
    await useAuthStore.getState().recheckMembership();
    // A rename and a demotion both land; the choice itself is untouched.
    expect(getActiveWorkspace()).toEqual({org_id: BOREALIS, name: 'Borealis', role: 'manager'});
  });
});

describe('an OLD server (no `workspaces`) is never touched', () => {
  it('leaves a null context null', async () => {
    meReturns({org: {id: ACME, name: 'Acme'}});
    await useAuthStore.getState().recheckMembership();
    expect(getActiveWorkspace()).toBeNull();
  });

  it('leaves an existing context exactly as it was', async () => {
    const before = {org_id: ACME, name: 'Acme', role: 'employee'} as const;
    useActiveWorkspace.getState().setActiveWorkspace({...before});
    meReturns({org: {id: BOREALIS, name: 'Borealis'}});
    await useAuthStore.getState().recheckMembership();
    expect(getActiveWorkspace()).toEqual(before);
  });
});

describe('F3 — EVERY /auth/me lane resolves, not just the boot one', () => {
  it('completeAuth (a fresh LOGIN) enters the single workspace', async () => {
    // Without this the first Channels open of a brand-new session had no
    // context at all — which is the unscoped cross-org list, on the very first
    // screen after signing in.
    meReturns({workspaces: [{org_id: ACME, name: 'Acme', role: 'employee'}]});
    await useAuthStore.getState().completeAuth();
    expect(getActiveWorkspace()).toEqual({org_id: ACME, name: 'Acme', role: 'employee'});
  });

  it('biometricSignIn resolves too', async () => {
    meReturns({workspaces: [{org_id: BOREALIS, name: 'Borealis', role: 'manager'}]});
    expect(await useAuthStore.getState().biometricSignIn()).toBe(true);
    expect(getActiveWorkspace()).toEqual({org_id: BOREALIS, name: 'Borealis', role: 'manager'});
  });
});

describe('F3 — an ABANDONED /auth/me lane must not repoint the surface', () => {
  /**
   * ⚠️ WHAT ACTUALLY PROTECTS THIS LANE, measured — not what I first assumed.
   *
   * I wrote this as a pin on the `if (stored)` gate and mutation-testing proved
   * it VACUOUS: deleting the gate left it green. The reason is the resolver's
   * shape. `syncWorkspaceContextFromMe` takes no arguments and reads
   * `useAuthStore.getState().user` — the STORED user — so a response the recipe
   * refused simply is not visible to it. The `stored` gate is defence in depth
   * on top of that (it also keeps the F3 owner stamp off an abandoned lane),
   * and it is pinned by the source scan below rather than by this test.
   *
   * So this asserts the property that IS load-bearing: the resolver never sees
   * the in-flight response. The second half is what makes it non-vacuous — the
   * identical payload does write, once the store accepts it.
   */
  it('the resolver reads the STORED user, so an abandoned response is inert', async () => {
    asyncStore[SNAPSHOT_KEY] = JSON.stringify(SNAPSHOT_USER);
    (tokenStore.get as jest.Mock).mockResolvedValue(JWT);
    let resolveMe: (v: unknown) => void = () => {};
    mockMe.mockReturnValueOnce(new Promise(r => { resolveMe = r; }));

    await useAuthStore.getState().initialize();
    // The snapshot lane authenticated optimistically and left /auth/me running.
    expect(useAuthStore.getState().isAuthenticated).toBe(true);

    useAuthStore.setState({isSigningOut: true});
    resolveMe({
      user: API_USER, account_kind: 'individual', must_set_password: false,
      membership_status: null, workspaces: [{org_id: ACME, name: 'Acme', role: 'employee'}],
    });
    for (let i = 0; i < 10; i++) { await Promise.resolve(); }

    expect(getActiveWorkspace()).toBeNull();

    // NON-VACUOUS: the very same payload DOES point the surface at Acme once
    // the store has accepted it. Without this half the null above would pass
    // for a fixture reason (no workspaces anywhere) rather than a real one.
    useAuthStore.setState({isSigningOut: false});
    meReturns({workspaces: [{org_id: ACME, name: 'Acme', role: 'employee'}]});
    await useAuthStore.getState().recheckMembership();
    expect(getActiveWorkspace()).toEqual({org_id: ACME, name: 'Acme', role: 'employee'});
  });

  it('the applyMe gate is spelled so an unapplied response cannot resolve', () => {
    // Source-anchored, because `initialize`'s snapshot lane is not reachable
    // from this rig without driving AsyncStorage and the boot timeout. The
    // shape is what matters: the resolver is called ONLY when the recipe
    // actually stored the user.
    const {readFileSync} = require('node:fs') as typeof import('node:fs');
    const {join} = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(process.cwd(), 'src', 'store', 'authStore.ts'), 'utf8')
      .split(/\r?\n/)
      .filter(l => {
        const t = l.trim();
        return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    expect(src).toMatch(/let stored = false;/);
    expect(src).toMatch(/stored = true;/);
    expect(src).toMatch(/if \(stored\) \{syncWorkspaceContextFromMe\(\);\}/);
    // …and the two guarded early-returns still sit ABOVE the assignment.
    const recipe = src.slice(src.indexOf('let stored = false;'), src.indexOf('stored = true;'));
    expect(recipe).toMatch(/if \(opts\?\.requireLive && \(!s\.isAuthenticated \|\| s\.isSigningOut\)\) \{return;\}/);
    expect(recipe).toMatch(/if \(!opts\?\.requireLive && bootMeAbandoned\) \{return;\}/);
  });
});

describe('F3 — a context never outlives the account it was chosen for', () => {
  it('an ACCOUNT SWITCH drops the previous user\'s organisation', async () => {
    // Sign-out is not the only door: a 401 teardown, a must_set_password
    // hand-off or a re-login installs a different user, and `activeWorkspace`
    // carries no owner of its own. Resolving user B against user A's context
    // would keep A's company naming the surface — and the X-Org-Context header
    // on B's attendance and incident WRITES.
    meReturns({workspaces: [{org_id: ACME, name: 'Acme', role: 'employee'}]});
    await useAuthStore.getState().recheckMembership();
    expect(getActiveWorkspace()?.org_id).toBe(ACME);

    const OTHER = {...API_USER, id: 'u2', email: 'other@x.io'};
    meReturns({workspaces: [{org_id: BOREALIS, name: 'Borealis', role: 'manager'}]}, OTHER);
    await useAuthStore.getState().recheckMembership();
    expect(getActiveWorkspace()).toEqual({org_id: BOREALIS, name: 'Borealis', role: 'manager'});
    // ⚠️ Measured: this row survives deleting the owner check, because B has
    // exactly ONE enterable affiliation and the F2 stale arm repairs it anyway.
    // It is here as the readable statement of the outcome; the row BELOW is the
    // one the owner check actually holds up.
  });

  it('…and lands on NULL rather than the old org when the new user has a choice', async () => {
    meReturns({workspaces: [{org_id: ACME, name: 'Acme', role: 'employee'}]});
    await useAuthStore.getState().recheckMembership();
    expect(getActiveWorkspace()?.org_id).toBe(ACME);

    const OTHER = {...API_USER, id: 'u3', email: 'three@x.io'};
    meReturns({workspaces: [
      {org_id: ACME, name: 'Acme', role: 'employee'},
      {org_id: BOREALIS, name: 'Borealis', role: 'manager'},
    ]}, OTHER);
    await useAuthStore.getState().recheckMembership();
    // Acme is enterable for u3 too, so the keep-on-valid arm would have carried
    // it straight through. The clear is what makes them pick for themselves.
    expect(getActiveWorkspace()).toBeNull();
  });
});

describe('endCpoAccess with a KEPT session clears the context', () => {
  it('the org that just revoked the CPO must not keep naming the surface', async () => {
    // Chidi owns a workspace, so the session survives the revocation and
    // signOut's own purge never runs. Without this clear the navigator's
    // agency exemption would PROTECT the dead context instead of ejecting it.
    useActiveWorkspace.getState().setActiveWorkspace({org_id: ACME, name: 'Acme CP', role: 'cpo'});
    await useAuthStore.getState().endCpoAccess({owns_workspace: true});
    expect(getActiveWorkspace()).toBeNull();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessEnded).toBe(false);
  });
});
