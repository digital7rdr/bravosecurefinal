/**
 * B-816 (founder, 2026-09-07) — the join-flow screens' back returns to the tab
 * the user came from (`returnTab`, stamped by `openJoinFlowScreen`'s tab hop),
 * not to the Channels root they were pushed on.
 *
 * RED-first: before the fix each of the four screens wired
 * `onBack={() => navigation.goBack()}` and no hardware handler, so from the
 * Home dashboard Approvals → back landed on DepartmentChannels.
 */
import React from 'react';
import {Text, BackHandler} from 'react-native';
import {render, fireEvent} from '@testing-library/react-native';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const mockGoBack = jest.fn();
const mockTabNavigate = jest.fn();
let mockParams: {returnTab?: string} | undefined;
let mockTabs: unknown;

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    goBack: mockGoBack,
    navigate: jest.fn(),
    getParent: () => mockTabs,
    getState: () => ({routeNames: ['DepartmentChannels', 'Approvals']}),
  }),
  useRoute: () => ({params: mockParams}),
  useFocusEffect: (cb: () => void | (() => void)) => {
    const R = require('react');
    R.useEffect(() => cb(), [cb]);
  },
  CommonActions: {navigate: jest.fn()},
}));
jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));
jest.mock('@navigation/navigationRef', () => ({
  navigationRef: {isReady: () => false, dispatch: jest.fn()},
  mountedTreeHasRoute: () => false,
}));

import {returnToTab, useJoinFlowBack} from '../joinFlowBack';

function Screen() {
  const onBack = useJoinFlowBack();
  return <Text onPress={onBack}>back</Text>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = undefined;
  mockTabs = {
    navigate: mockTabNavigate,
    getParent: () => undefined,
    getState: () => ({routeNames: ['Home', 'Channels', 'Attend', 'Incident', 'Vault']}),
  };
});

describe('returnToTab', () => {
  it('pops FIRST, then focuses the tab on the navigator that registers it', () => {
    const calls: string[] = [];
    const tabs = {
      navigate: (...a: unknown[]) => { calls.push(`tab:${String(a[0])}`); },
      getParent: () => undefined,
      getState: () => ({routeNames: ['Home', 'Channels']}),
    };
    const nav = {
      goBack: () => { calls.push('pop'); },
      navigate: jest.fn(),
      getParent: () => tabs,
      getState: () => ({routeNames: ['DepartmentChannels', 'Approvals']}),
    };
    expect(returnToTab(nav, 'Home')).toBe(true);
    // Switching tabs while the screen is still on the Channels stack would
    // leave it there for the next Channels tap — the pop must come first.
    expect(calls).toEqual(['pop', 'tab:Home']);
  });

  it('with no navigator registering the tab: still pops (the press is never swallowed)', () => {
    const goBack = jest.fn();
    const nav = {goBack, navigate: jest.fn(), getParent: () => undefined, getState: () => ({routeNames: ['Approvals']})};
    expect(returnToTab(nav, 'Home')).toBe(false);
    expect(goBack).toHaveBeenCalledTimes(1);
  });
});

describe('useJoinFlowBack', () => {
  it('without returnTab the chevron is the plain pop and no hardware handler is registered', () => {
    const add = jest.spyOn(BackHandler, 'addEventListener');
    const u = render(<Screen />);
    fireEvent.press(u.getByText('back'));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockTabNavigate).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    add.mockRestore();
  });

  it('with returnTab: Home the chevron pops and returns to Home', () => {
    mockParams = {returnTab: 'Home'};
    const u = render(<Screen />);
    fireEvent.press(u.getByText('back'));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockTabNavigate).toHaveBeenCalledWith('Home');
  });

  it('with returnTab the HARDWARE back does the same, and is focus-scoped (removed on blur/unmount)', () => {
    mockParams = {returnTab: 'Home'};
    const remove = jest.fn();
    const add = jest.spyOn(BackHandler, 'addEventListener').mockReturnValue({remove} as never);
    const u = render(<Screen />);
    expect(add).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
    const handler = add.mock.calls[0][1] as () => boolean;
    expect(handler()).toBe(true);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockTabNavigate).toHaveBeenCalledWith('Home');
    u.unmount();
    expect(remove).toHaveBeenCalled();
    add.mockRestore();
  });
});

/**
 * Wiring pin — every join-flow screen's header back goes through the hook.
 * A screen that keeps `onBack={() => navigation.goBack()}` silently reverts
 * to the Channels-root landing for the whole flow it hosts.
 */
describe('the four join-flow screens wire their header back through useJoinFlowBack', () => {
  const SCREENS = ['ApprovalsScreen', 'JoinWorkspaceScreen', 'ApprovalStatusScreen', 'EnterpriseSetupScreen'];
  const strip = (s: string) => s.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const read = (rel: string) => strip(readFileSync(join(process.cwd(), 'src', 'screens', 'deptchat', rel), 'utf8'));

  for (const name of SCREENS) {
    it(name, () => {
      const src = read(`${name}.tsx`);
      expect(src).toMatch(/import \{useJoinFlowBack\} from '\.\/joinFlowBack';/);
      expect(src).toMatch(/const onBack = useJoinFlowBack\(\);/);
      expect(src).toMatch(/<ObHeader[\s\S]{0,120}?onBack=\{onBack\}/);
      expect(src).not.toMatch(/onBack=\{\(\) => navigation\.goBack\(\)\}/);
    });
  }

  it('the hook registers the hardware handler INSIDE useFocusEffect (N1), never useEffect', () => {
    const src = read('joinFlowBack.ts');
    const at = src.indexOf("BackHandler.addEventListener('hardwareBackPress'");
    expect(at).toBeGreaterThan(-1);
    const before = src.slice(0, at);
    expect(before.lastIndexOf('useFocusEffect(')).toBeGreaterThan(before.lastIndexOf('useEffect('));
  });
});
