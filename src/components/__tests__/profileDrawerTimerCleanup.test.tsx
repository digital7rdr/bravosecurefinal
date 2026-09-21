/**
 * B-865 — a drawer back-guard timer must not outlive the drawer.
 *
 * `ProfileDrawerModal` defers every row's destination by 220 ms (NAV-08: a back
 * press inside that window pops the hosting screen, and the timer must not then
 * navigate on its behalf). Each of the three deferrals was a BARE `setTimeout`
 * with no unmount cleanup, so a drawer that went away inside the window still
 * fired its callback — in tests, into a torn-down module registry
 * (`TypeError: openWorkspaceHub is not a function`, attributed to whichever
 * suite happened to be executing 220 ms later; three full app-project runs named
 * three DIFFERENT suites with the identical error). On a device the same timer
 * navigates a shell the user has already left.
 *
 * NAV_RAPID_USE_LOOP §2 N6 — timer-driven navigation. The `isFocused` probe
 * inside the callback is NOT this guard: an unmounted drawer's navigation handle
 * can report anything, and the callback itself is what must never run.
 *
 * All three deferral sites are covered (`go`, `openDeptChat`, `goToWorkspaceHub`)
 * plus the positive control, so "never navigates" cannot pass this suite.
 */
import React from 'react';
import {render, fireEvent} from '@testing-library/react-native';

const mockNavigate = jest.fn();
const mockOpenWorkspaceHub = jest.fn(() => ({ok: true}));
const mockOpenDepartmentChannels = jest.fn(() => ({ok: true}));
const mockConfirm = jest.fn((_dest: string, _onYes: () => void) => {});
let mockUser: Record<string, unknown>;

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({
    navigate: mockNavigate,
    getParent: () => undefined,
    getState: () => ({routeNames: []}),
    isFocused: () => true,
  }),
}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
jest.mock('@utils/alert', () => ({
  Alert: {alert: jest.fn()},
  confirmSwitchDashboard: (d: string, y: () => void) => mockConfirm(d, y),
}));
jest.mock('@store/authStore', () => ({
  useAuthStore: Object.assign(
    (sel?: (s: unknown) => unknown) => (sel ? sel({user: mockUser, signOut: jest.fn()}) : {user: mockUser, signOut: jest.fn()}),
    {getState: () => ({user: mockUser})}),
}));
jest.mock('@store/entitlements', () => ({
  useEntitlements: () => ({hasDeptChannels: true, isOrgAffiliated: true}),
  showEnterpriseUpgradePrompt: jest.fn(),
}));
jest.mock('@navigation/departmentalEntry', () => ({
  findNavigatorWithRoute: () => undefined,
  openDepartmentChannels: (...a: unknown[]) => mockOpenDepartmentChannels(...(a as [])),
  openWorkspaceHub: (...a: unknown[]) => mockOpenWorkspaceHub(...(a as [])),
}));
jest.mock('@navigation/navigationRef', () => ({
  navigationRef: {isReady: () => false, dispatch: jest.fn()},
  mountedTreeHasRoute: () => false,
  mountedStackHasRoutesAbove: () => false,
}));
jest.mock('@navigation/openPricing', () => ({openPricing: jest.fn(), openEnterprisePricing: jest.fn()}));

import {ProfileDrawerModal} from '../ProfileDrawerModal';

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockUser = {id: 'u1', full_name: 'A B', email: 'a@b.c', account_kind: 'client'};
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

/** Press a confirm-gated row and say Yes, the way the user does. */
function pressAndConfirm(u: ReturnType<typeof render>, label: string): void {
  fireEvent.press(u.getByText(label));
  const call = mockConfirm.mock.calls.at(-1);
  expect(call).toBeTruthy();
  (call as [string, () => void])[1]();
}

describe('B-865 — no deferred destination survives the drawer', () => {
  it('`go` — a plain row navigates nothing once the drawer has unmounted', () => {
    const u = render(<ProfileDrawerModal visible onClose={jest.fn()} />);
    fireEvent.press(u.getByText('My Profile'));
    u.unmount();                       // …inside the 220 ms window
    jest.advanceTimersByTime(5000);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('`goToWorkspaceHub` — the hub resolver is the one that crashed other suites', () => {
    mockUser = {...mockUser, owns_workspace: true};
    const u = render(<ProfileDrawerModal visible onClose={jest.fn()} />);
    pressAndConfirm(u, 'Workspaces');
    u.unmount();
    jest.advanceTimersByTime(5000);
    expect(mockOpenWorkspaceHub).not.toHaveBeenCalled();
  });

  it('`openDeptChat` — the third deferral site is cleaned up too', () => {
    mockUser = {...mockUser, account_kind: 'agency'};   // provider arm renders the Channels row
    const u = render(<ProfileDrawerModal visible onClose={jest.fn()} />);
    pressAndConfirm(u, 'Channels');
    u.unmount();
    jest.advanceTimersByTime(5000);
    expect(mockOpenDepartmentChannels).not.toHaveBeenCalled();
  });

  it('…and a drawer that stays mounted STILL navigates (the cleanup is not a mute button)', () => {
    const u = render(<ProfileDrawerModal visible onClose={jest.fn()} />);
    fireEvent.press(u.getByText('My Profile'));
    jest.advanceTimersByTime(300);
    expect(mockNavigate).toHaveBeenCalledWith('ProfileTab', undefined);
  });

  it('the hub row still resolves when the drawer stays mounted', () => {
    mockUser = {...mockUser, owns_workspace: true};
    const u = render(<ProfileDrawerModal visible onClose={jest.fn()} />);
    pressAndConfirm(u, 'Workspaces');
    jest.advanceTimersByTime(300);
    expect(mockOpenWorkspaceHub).toHaveBeenCalledTimes(1);
  });
});

/**
 * The RULE, not the three sites. A fourth deferral added later must join the
 * helper rather than hand-rolling `setTimeout` again — the scan is the only
 * thing that can see a site this suite does not enumerate.
 *
 * Comments stripped (CRLF-safe: this file is CRLF) so the prose above, and the
 * `setTimeout` named in ProfileDrawerModal's own comments, cannot satisfy or
 * trip the check.
 */
describe('B-865 — the deferral rule', () => {
  const src = require('node:fs')
    .readFileSync(require('node:path').join(process.cwd(), 'src/components/ProfileDrawerModal.tsx'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l: string) => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');

  it('no bare setTimeout/setInterval remains — every deferral goes through the tracked helper', () => {
    const bare = [...src.matchAll(/(?<!\w)(setTimeout|setInterval)\s*\(/g)]
      .filter((m: RegExpMatchArray) => {
        // The helper's own single call site is the tracked one.
        const before = src.slice(Math.max(0, (m.index ?? 0) - 120), m.index);
        return !/const handle\s*=\s*$/.test(before);
      });
    expect(bare.map((m: RegExpMatchArray) => src.slice(m.index ?? 0, (m.index ?? 0) + 40))).toEqual([]);
  });

  it('the helper clears its handles on unmount', () => {
    expect(src).toMatch(/useEffect\(\s*\(\)\s*=>\s*\(\)\s*=>\s*\{/);
    expect(src).toMatch(/clearTimeout/);
  });
});
