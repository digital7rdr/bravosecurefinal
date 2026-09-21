/**
 * B-816 (founder, 2026-09-07) — "If I enter approvals and press back it enters
 * Channels. It should go back to the dashboard I was previously on."
 *
 * The tab hop pushes the screen on the Channels stack (R8-5 keeps the tab
 * bar), so a pop lands on the Channels root. The hop now stamps `returnTab`
 * — the tab the user was LOOKING AT, read off the tab navigator's own state —
 * and `useJoinFlowBack` returns there. Only the tab hop stamps it, and only
 * when the user was not already on Channels.
 *
 * RED-first: before the fix every tab-hop call was the bare
 * `{screen, initial: false}` regardless of the focused tab.
 */
jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));
jest.mock('@react-navigation/native', () => ({
  CommonActions: {navigate: (...a: unknown[]) => ({type: 'NAVIGATE', a})},
}));
jest.mock('../navigationRef', () => ({
  navigationRef: {isReady: () => false, dispatch: jest.fn(), getRootState: () => undefined},
  mountedTreeHasRoute: () => false,
}));

import {openJoinFlowScreen, focusedRouteName} from '../departmentalEntry';

interface FakeNav {
  navigate: jest.Mock;
  getParent: () => FakeNav | undefined;
  getState: () => {routeNames: string[]; routes?: Array<{name: string}>; index?: number};
}

function chain(...levels: string[][]): FakeNav[] {
  const navs: FakeNav[] = levels.map(routeNames => ({
    navigate: jest.fn(),
    getParent: () => undefined,
    getState: () => ({routeNames}),
  }));
  navs.forEach((n, i) => { n.getParent = () => navs[i + 1]; });
  return navs;
}

const TABS = ['Home', 'Channels', 'Attend', 'Incident', 'Vault'];

/** The Departmental shell with its tab navigator focused on `index`. */
function tabShell(index: number): FakeNav[] {
  const navs = chain(TABS, ['AgentDashboard', 'Departmental']);
  navs[0].getState = () => ({routeNames: TABS, routes: TABS.map(name => ({name})), index});
  return navs;
}

describe('focusedRouteName', () => {
  it('reads the focused route off a navigator state', () => {
    expect(focusedRouteName(tabShell(0)[0])).toBe('Home');
    expect(focusedRouteName(tabShell(4)[0])).toBe('Vault');
  });
  it('is null for a state without routes/index, a bad index, or no navigator', () => {
    expect(focusedRouteName(chain(TABS)[0])).toBeNull();
    const navs = tabShell(9);
    expect(focusedRouteName(navs[0])).toBeNull();
    expect(focusedRouteName(null)).toBeNull();
    expect(focusedRouteName(undefined)).toBeNull();
  });
});

describe('openJoinFlowScreen — B-816 the tab hop remembers the tab the user came from', () => {
  it('from the HOME dashboard: stamps returnTab: Home on the pushed screen', () => {
    const navs = tabShell(0);
    expect(openJoinFlowScreen(navs[0], 'Approvals')).toEqual({ok: true, via: 'tab'});
    expect(navs[0].navigate).toHaveBeenCalledWith(
      'Channels', {screen: 'Approvals', initial: false, params: {returnTab: 'Home'}});
  });

  it('from a hidden module tab (Attend) the stamp names THAT tab', () => {
    const navs = tabShell(2);
    openJoinFlowScreen(navs[0], 'Approvals');
    expect(navs[0].navigate).toHaveBeenCalledWith(
      'Channels', {screen: 'Approvals', initial: false, params: {returnTab: 'Attend'}});
  });

  it('already on the CHANNELS tab: no stamp — back is the plain pop', () => {
    const navs = tabShell(1);
    openJoinFlowScreen(navs[0], 'ApprovalStatus');
    expect(navs[0].navigate).toHaveBeenCalledWith('Channels', {screen: 'ApprovalStatus', initial: false});
  });

  it('a navigator with no focused-route state: no stamp, never a throw', () => {
    const navs = chain(TABS, ['AgentDashboard', 'Departmental']);
    expect(openJoinFlowScreen(navs[0], 'JoinWorkspace')).toEqual({ok: true, via: 'tab'});
    expect(navs[0].navigate).toHaveBeenCalledWith('Channels', {screen: 'JoinWorkspace', initial: false});
  });

  it('the non-tab branches carry no returnTab — nothing to return to', () => {
    const [nav] = chain(['AgentHome', 'ActivityCenter', 'Departmental']);
    expect(openJoinFlowScreen(nav, 'Approvals')).toEqual({ok: true, via: 'shell'});
    expect(nav.navigate).toHaveBeenCalledWith(
      'Departmental', {screen: 'Channels', params: {screen: 'Approvals', initial: false}});
  });
});
