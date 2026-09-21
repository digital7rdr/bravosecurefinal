/**
 * R8-6 / R6-4 — `openPricing` had no test, on a helper that six call sites use
 * and that Phase 3 turned into the ONLY in-app route to buying Enterprise from
 * the feature that advertises it.
 *
 * The bug it now guards: `Pricing` is registered in BookingNavigator alone,
 * reached through `SecureTab`, which exists only in the client tab shell.
 * MainNavigator renders exactly ONE of CpoNavigator / AgentNavigator / that
 * shell — so in the Agent and CPO shells the dispatch named a route the mounted
 * tree does not have, the nested payload went unhandled, and the button was
 * silently dead. Phase 3 made that worse by replacing a working upgrade DIALOG
 * with a redirect to a gate whose upgrade button was that dead button.
 */
const mockDispatch = jest.fn();
const mockGetRootState = jest.fn();
let mockReady = true;

jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  createNavigationContainerRef: () => ({
    isReady: () => mockReady,
    getRootState: () => mockGetRootState(),
    dispatch: (...a: unknown[]) => mockDispatch(...a),
  }),
}));
jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));

import {Alert} from '@utils/alert';
import {openPricing} from '../openPricing';

/** The client tab shell — SecureTab registered on the tab navigator itself. */
const clientShell = {
  routeNames: ['Auth', 'Main'],
  routes: [{}, {state: {routeNames: ['MessengerTab', 'SecureTab', 'ProfileTab']}}],
};
/** The agency shell — MainNavigator returns AgentNavigator INSTEAD of the tabs. */
const agentShell = {
  routeNames: ['Auth', 'Main'],
  routes: [{}, {state: {routeNames: ['AgentDashboard', 'Departmental']}}],
};

beforeEach(() => {
  mockReady = true;
  mockDispatch.mockClear();
  mockGetRootState.mockReset();
  (Alert.alert as jest.Mock).mockClear();
});

describe('openPricing', () => {
  it('CLIENT shell: dispatches Main → SecureTab → Pricing', () => {
    mockGetRootState.mockReturnValue(clientShell);
    expect(openPricing()).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(Alert.alert).not.toHaveBeenCalled();
    // The payload shape is the contract — a wrong nesting is silently dropped.
    const action = mockDispatch.mock.calls[0][0] as {payload?: unknown};
    // `initial: false` is part of the payload contract, not decoration: without
    // it the lazy BookingNavigator ROOTS at Pricing (R10-1). Pinning the
    // payload without the flag pins the defect as the contract.
    expect(action.payload).toMatchObject({
      name: 'Main',
      params: {screen: 'SecureTab', params: {screen: 'Pricing', initial: false}},
    });
  });

  it('AGENT shell: says so instead of dispatching into nothing', () => {
    mockGetRootState.mockReturnValue(agentShell);
    expect(openPricing()).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledTimes(1);
  });

  it('before the container is ready it is a no-op, not a throw or an alert', () => {
    mockReady = false;
    expect(openPricing()).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
    // No alert here on purpose: "not mounted yet" is a race, not a user-facing
    // fact, and alerting on it would fire during boot.
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});

/**
 * B-870 (founder, 2026-09-12) — "when he is on the plan page and tries to go
 * back, he goes back to the Secure Services page."
 *
 * This dispatch is what moves the user off the tab they were on, so it is the
 * one place that can record where they came from — exactly the B-816 rule one
 * level up (that one stamps a DEPARTMENTAL tab, this one a ROOT tab). Read off
 * the mounted tree, never supplied by a caller: six call sites open this door
 * and none of them can know which tab is focused.
 */
describe('B-870 — the hop stamps the root tab the user came from', () => {
  const TABS = ['MessengerTab', 'SecureTab', 'ProfileTab'];
  const shellOn = (tab: string) => ({
    routeNames: ['Auth', 'Main'],
    routes: [
      {name: 'Auth'},
      {name: 'Main', state: {
        routeNames: TABS,
        index: TABS.indexOf(tab),
        routes: TABS.map(t => ({name: t})),
      }},
    ],
  });

  /** The nested `params` the Pricing route will actually receive. */
  function innerParams(): {only?: string; returnTab?: string} | undefined {
    const action = mockDispatch.mock.calls[0][0] as {
      payload?: {params?: {params?: {params?: {only?: string; returnTab?: string}}}};
    };
    return action.payload?.params?.params?.params;
  }

  it('THE BUG: from the MESSENGER tab the Pricing route carries returnTab', () => {
    mockGetRootState.mockReturnValue(shellOn('MessengerTab'));
    expect(openPricing({only: 'enterprise'})).toBe(true);
    expect(innerParams()).toMatchObject({only: 'enterprise', returnTab: 'MessengerTab'});
  });

  it('from PROFILE too — the drawer upgrade prompt is the same class of hop', () => {
    mockGetRootState.mockReturnValue(shellOn('ProfileTab'));
    expect(openPricing()).toBe(true);
    expect(innerParams()?.returnTab).toBe('ProfileTab');
  });

  it('already ON SecureTab: there is nothing to return to, so no stamp', () => {
    mockGetRootState.mockReturnValue(shellOn('SecureTab'));
    expect(openPricing()).toBe(true);
    expect(innerParams()?.returnTab).toBeUndefined();
  });

  it('a tree that does not expose a focused route stamps NOTHING rather than guessing', () => {
    // `clientShell` registers the tabs but carries no routes/index — the shape
    // a torn or not-yet-committed tree has. A guess here would send back
    // presses to a tab the user was never on.
    mockGetRootState.mockReturnValue(clientShell);
    expect(openPricing()).toBe(true);
    expect(innerParams()?.returnTab).toBeUndefined();
  });
});
