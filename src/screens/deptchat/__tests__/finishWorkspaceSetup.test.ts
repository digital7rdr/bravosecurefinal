/**
 * B-871, second half (coordinator follow-up, 2026-09-12) — THE FLOW HAS TO END.
 *
 * The first cut re-pointed the post-create destination at the Workspace Hub
 * (`replace('WorkspaceHub')`). That fixed where the owner lands and left the
 * screen BEHIND them wrong: `EnterpriseSetupScreen` stays mounted under the
 * hub, still showing "How are you joining Bravo Enterprise? / Create a
 * workspace / Join a workspace", and its owner-redirect effect is
 * `[navigation]`-scoped so it already ran and never re-fires. Back from the hub
 * therefore lands on a create-or-join fork for a workspace the user just
 * created, and pressing Create again earns the server's `already_exists`
 * alert. Same founder complaint as B-871 itself in a different costume:
 * finishing a flow and finding a dead screen behind you.
 *
 * So the shape is an ENDING, not another hop: retire the setup fork from the
 * stack that hosts it, THEN land on the hub.
 *
 * WHY `pop(n)` AND NOT `popToTop()` OR `reset()`:
 *  - `popToTop()` throws away real context. In the client shell the stack is
 *    `[MessengerHome, …, DepartmentChannels, EnterpriseSetup, CreateWorkspace]`
 *    and popping to the top would discard the channels list the user came
 *    from, so back from the hub would land on the messenger home.
 *  - `reset()` with a keyless route list drops the NESTED state of everything
 *    kept — a `Departmental` shell beneath would silently rewind to its
 *    initial tab. `pop` leaves everything below untouched.
 *
 * RED-first: this module did not exist, and `CreateWorkspaceScreen` replaced
 * the top route only.
 */
jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));

/**
 * Stub the container REF, keep the real `navigationRef` module — the same seam
 * `departmentalEntry.test.ts` uses, and for the same reason: re-implementing
 * the resolver inside a mock factory is the duplicate-copy bug class aimed at
 * the regression test itself.
 */
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  createNavigationContainerRef: () => ({
    isReady: () => false,
    dispatch: jest.fn(),
    getRootState: () => undefined,
  }),
}));

import {
  SETUP_FLOW_ROUTES,
  setupRoutesOnTop,
  finishWorkspaceSetup,
  type SetupFlowNavigation,
} from '../finishWorkspaceSetup';

/** One level of a navigator chain. `calls` is SHARED so order across levels is
 *  observable — the pop must happen before the landing, never after. */
interface FakeNav extends SetupFlowNavigation {
  navigate: jest.Mock;
  pop: jest.Mock;
}

function chain(
  calls: string[],
  ...levels: Array<{routeNames: string[]; routes?: string[]}>
): FakeNav[] {
  const navs: FakeNav[] = levels.map((lvl, i) => ({
    navigate: jest.fn((...a: unknown[]) => { calls.push(`nav${i}:${String(a[0])}`); }),
    pop: jest.fn((n?: number) => { calls.push(`pop${i}:${String(n)}`); }),
    getParent: () => undefined,
    getState: () => ({
      routeNames: lvl.routeNames,
      routes: (lvl.routes ?? []).map(name => ({name})),
      index: (lvl.routes?.length ?? 1) - 1,
    }),
  }));
  navs.forEach((n, i) => { n.getParent = () => navs[i + 1]; });
  return navs;
}

/**
 * THE TWO REAL TOPOLOGIES (verified against src/navigation/*.tsx).
 *
 * `CreateWorkspace` is registered in exactly two navigators: MessengerNavigator
 * — which also registers `WorkspaceHub` — and DepartmentalNavigator's Channels
 * stack, which does NOT. Every shell that hosts the `Departmental` surface
 * registers `WorkspaceHub` on its ROOT stack (pinned by
 * `src/navigation/__tests__/workspaceHubReachability.test.ts`), so the second
 * topology always finds it one or two levels up.
 */
const clientStack = (calls: string[]) => chain(calls, {
  routeNames: ['MessengerHome', 'Groups', 'DepartmentChannels', 'EnterpriseSetup',
    'CreateWorkspace', 'JoinWorkspace', 'WorkspaceHub', 'Departmental'],
  routes: ['MessengerHome', 'DepartmentChannels', 'EnterpriseSetup', 'CreateWorkspace'],
});

const departmentalStack = (calls: string[]) => chain(calls,
  // ChannelsStack — hosts the fork, does NOT register the hub.
  {routeNames: ['DepartmentChannels', 'DepartmentChat', 'EnterpriseSetup', 'CreateWorkspace', 'JoinWorkspace'],
    routes: ['DepartmentChannels', 'EnterpriseSetup', 'CreateWorkspace']},
  // The 5-tab shell.
  {routeNames: ['Home', 'Channels', 'Attend', 'Incident', 'Vault'], routes: ['Channels']},
  // The host ROOT stack (Agent / CPO / Messenger) — this is where the hub is.
  {routeNames: ['AgentDashboard', 'Departmental', 'WorkspaceHub'], routes: ['AgentDashboard', 'Departmental']},
);

describe('setupRoutesOnTop — how much of the stack the finished flow owns', () => {
  const st = (...routes: string[]) => ({routeNames: routes, routes: routes.map(name => ({name}))});

  it('counts the contiguous setup run at the TOP of the stack', () => {
    expect(setupRoutesOnTop(st('DepartmentChannels', 'EnterpriseSetup', 'CreateWorkspace'))).toBe(2);
    expect(setupRoutesOnTop(st('MessengerHome', 'Groups', 'DepartmentChannels', 'EnterpriseSetup', 'CreateWorkspace'))).toBe(2);
    // Reached without the fork (a future direct door): only this screen is ours.
    expect(setupRoutesOnTop(st('DepartmentChannels', 'CreateWorkspace'))).toBe(1);
  });

  it('is CONTIGUOUS-from-top, so it can never eat a screen it does not own', () => {
    // An EnterpriseSetup lower down belongs to some earlier journey; only the
    // run the user is standing on is this flow.
    expect(setupRoutesOnTop(st('EnterpriseSetup', 'DepartmentChannels', 'CreateWorkspace'))).toBe(1);
  });

  it('never empties the stack — the clamp is a floor, not an expected path', () => {
    // `openJoinFlowScreen` passes `initial: false` precisely so the fork is
    // never the root (R9-2), so this is defensive.
    expect(setupRoutesOnTop(st('CreateWorkspace'))).toBe(0);
    expect(setupRoutesOnTop(st('EnterpriseSetup', 'CreateWorkspace'))).toBe(1);
  });

  it('tolerates a torn or absent state instead of throwing', () => {
    expect(setupRoutesOnTop(undefined)).toBe(0);
    expect(setupRoutesOnTop({routeNames: []})).toBe(0);
    expect(setupRoutesOnTop({routes: []})).toBe(0);
  });

  it('owns the CREATE arm only — the status surfaces are somebody else\'s', () => {
    // ApprovalStatus/Approvals can legitimately sit in these stacks and are not
    // part of the create flow; retiring them would delete a screen the user
    // still needs.
    expect([...SETUP_FLOW_ROUTES].sort()).toEqual(['CreateWorkspace', 'EnterpriseSetup']);
  });
});

describe('finishWorkspaceSetup — the client shell (hub in the SAME stack)', () => {
  it('THE BUG: retires the fork FIRST, then lands on the hub', () => {
    const calls: string[] = [];
    const [nav] = clientStack(calls);
    expect(finishWorkspaceSetup(nav)).toBe('hub-in-stack');
    // Order is the contract: landing first would leave the fork buried under
    // the hub, which is exactly the defect this closes.
    expect(calls).toEqual(['pop0:2', 'nav0:WorkspaceHub']);
  });

  it('leaves DepartmentChannels behind it, so back from the hub is sensible', () => {
    const calls: string[] = [];
    const [nav] = clientStack(calls);
    finishWorkspaceSetup(nav);
    // [MessengerHome, DepartmentChannels, EnterpriseSetup, CreateWorkspace]
    // minus the two setup routes = [MessengerHome, DepartmentChannels].
    expect(nav.pop).toHaveBeenCalledWith(2);
  });
});

describe('finishWorkspaceSetup — the departmental shell (hub on an ANCESTOR)', () => {
  it('pops the fork off the Channels stack, then opens the hub on the host', () => {
    const calls: string[] = [];
    const [inner, tabs, root] = departmentalStack(calls);
    expect(finishWorkspaceSetup(inner)).toBe('hub-on-ancestor');
    expect(calls).toEqual(['pop0:2', 'nav2:WorkspaceHub']);
    // The inner stack must not try to navigate to a route it does not register
    // — that is the silently-dropped navigate this repo keeps re-shipping.
    expect(inner.navigate).not.toHaveBeenCalled();
    expect(tabs.navigate).not.toHaveBeenCalled();
    expect(root.navigate).toHaveBeenCalledWith('WorkspaceHub');
  });

  it('back from the hub lands on the Departmental shell, in EVERY shell that has one', () => {
    // Structural claim: the hub is pushed on the ROOT stack above `Departmental`
    // (the focused route there), so a pop returns to the shell — whose Channels
    // tab is now back at DepartmentChannels because we popped the fork first.
    const calls: string[] = [];
    const [inner, , root] = departmentalStack(calls);
    finishWorkspaceSetup(inner);
    const rootRoutes = root.getState?.()?.routes?.map(r => r.name);
    expect(rootRoutes?.[rootRoutes.length - 1]).toBe('Departmental');
    expect(inner.pop).toHaveBeenCalledWith(2);
  });
});

describe('finishWorkspaceSetup — the resolution ladder is preserved', () => {
  it('falls back to the Departmental shell when no navigator registers the hub', () => {
    // Unreachable today (workspaceHubReachability pins that every shell hosting
    // Departmental also registers WorkspaceHub) and kept anyway: a replace
    // naming an unregistered route is silently dropped, and this arm is what
    // made the pre-B-871 code safe in the Agent and CPO shells.
    const calls: string[] = [];
    const [inner] = chain(calls,
      {routeNames: ['DepartmentChannels', 'EnterpriseSetup', 'CreateWorkspace'],
        routes: ['DepartmentChannels', 'EnterpriseSetup', 'CreateWorkspace']},
      {routeNames: ['AgentDashboard', 'Departmental'], routes: ['AgentDashboard', 'Departmental']},
    );
    expect(finishWorkspaceSetup(inner)).toBe('shell-fallback');
    expect(calls).toEqual(['pop0:2', 'nav1:Departmental']);
  });

  it('with NOTHING to land on: the fork is still retired, and it says so', () => {
    // Honest outcome rather than an invented destination. The workspace exists
    // and the session has been refreshed, so popping back to whatever was
    // under the fork is a real terminal state, not a dead end.
    const calls: string[] = [];
    const [inner] = chain(calls,
      {routeNames: ['DepartmentChannels', 'EnterpriseSetup', 'CreateWorkspace'],
        routes: ['DepartmentChannels', 'EnterpriseSetup', 'CreateWorkspace']},
    );
    expect(finishWorkspaceSetup(inner)).toBe('none');
    expect(calls).toEqual(['pop0:2']);
  });

  it('the degenerate root case: no pop (never empty a stack), still lands', () => {
    const calls: string[] = [];
    const [nav] = chain(calls, {
      routeNames: ['CreateWorkspace', 'WorkspaceHub'],
      routes: ['CreateWorkspace'],
    });
    expect(finishWorkspaceSetup(nav)).toBe('hub-in-stack');
    expect(calls).toEqual(['nav0:WorkspaceHub']);
    expect(nav.pop).not.toHaveBeenCalled();
  });
});
