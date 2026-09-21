/**
 * D1 (B-856 A4) — inside a WORKSPACE, the Attendance screen shows THAT
 * workspace's records.
 *
 * The device pass entered "QA Echo Ltd" and the screen showed the QA Delta
 * session: the ON SHIFT pill, "Checked in …", a Delta recent row, and an
 * "End shift — QA Delta Corp" footer. It survived pull-to-refresh. The server
 * was correct throughout — `GET /attendance/me` with `X-Org-Context = Echo`
 * answers `[]` — because this screen passes `{crossOrg: true}` on every read.
 *
 * That flag is RIGHT in the officer shells and WRONG here: the same component
 * is mounted by `DepartmentalNavigator` as the member's `Attendance` route,
 * where the entered workspace IS the employer and the hub can always clear the
 * context. So the flag follows the SHELL.
 *
 * The one thing that must not vanish with it: the database allows a single open
 * session per PERSON across all organisations, so a scoped read can hide the
 * fact that you are on shift somewhere else — and then "Clock in" looks
 * available and fails. That is one compact labelled notice, not a rendered
 * Delta shift.
 *
 * A RENDER test: the defect is which ARGUMENT a read is made with and what the
 * screen then draws, neither of which a source scan can see.
 */
import React from 'react';
import {act, render} from '@testing-library/react-native';
import type {ShiftSessionDto} from '@services/api';

jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));
jest.mock('@hooks/useBottomInset', () => ({
  useBottomInset: () => ({bottomPad: () => 0, safeBottom: 0, base: 0, gap: () => 0}),
}));
jest.mock('@/modules/messenger/ui/AmbientBg', () => ({AmbientBg: 'AmbientBg'}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn()}),
  useFocusEffect: (cb: () => void | (() => void)) => {
    const R = require('react');
    R.useEffect(() => cb(), [cb]);
  },
}));
jest.mock('@navigation/tapGuard', () => ({navigateOnce: jest.fn(), goBackOnce: jest.fn()}));
jest.mock('react-native-geolocation-service', () => ({
  __esModule: true,
  default: {getCurrentPosition: jest.fn()},
  getCurrentPosition: jest.fn(),
}));

/** The ONE thing overridden on the shared obsidian kit. */
let mockInDeptShell = true;
jest.mock('@screens/deptchat/_obsidian', () => ({
  ...jest.requireActual('@screens/deptchat/_obsidian'),
  useInDepartmentalShell: () => mockInDeptShell,
}));

const mockMyShifts = jest.fn();
const mockMyTodayShift = jest.fn();
jest.mock('@services/api', () => ({
  attendanceApi: {
    myShifts: (...a: unknown[]) => mockMyShifts(...a),
    myTodayShift: (...a: unknown[]) => mockMyTodayShift(...a),
    clockIn: jest.fn(), clockOut: jest.fn(),
  },
}));

const mockAuthState = {
  user: {
    id: 'u1',
    workspaces: [{org_id: 'org-echo'}, {org_id: 'org-delta'}],
  },
};
jest.mock('@store/authStore', () => {
  const useAuthStore = (sel: (s: unknown) => unknown) => sel(mockAuthState);
  useAuthStore.getState = () => mockAuthState;
  return {useAuthStore};
});

import AttendanceScreen from '@screens/agent/AttendanceScreen';
import {useActiveWorkspace} from '@store/activeWorkspace';

const DELTA_OPEN: ShiftSessionDto = {
  id: 'ses-delta', org_user_id: 'org-delta', org_name: 'QA Delta Corp',
  cpo_user_id: 'u1', status: 'open',
  clock_in_at: '2026-09-12T02:09:00.000Z',
  clock_in_lat: null, clock_in_lng: null, clock_out_at: null,
} as ShiftSessionDto;

async function mount() {
  const ui = render(<AttendanceScreen />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return ui;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockInDeptShell = true;
  useActiveWorkspace.getState().setActiveWorkspace(
    {org_id: 'org-echo', name: 'QA Echo Ltd', role: 'employee'});
  // The server is correct: scoped reads answer [], cross-org answers Delta.
  mockMyShifts.mockImplementation((opts?: {crossOrg?: boolean}) =>
    Promise.resolve({data: opts?.crossOrg ? [DELTA_OPEN] : []}));
  mockMyTodayShift.mockResolvedValue({data: null});
});
afterEach(() => { useActiveWorkspace.getState().setActiveWorkspace(null); });

describe('D1 — inside a workspace the screen reads that workspace', () => {
  it('sends the scoped read and lists nothing from the other organisation', async () => {
    const ui = await mount();

    expect(mockMyShifts).toHaveBeenCalledWith({crossOrg: false});
    expect(mockMyTodayShift).toHaveBeenCalledWith({crossOrg: false});
    // The Delta session is not this workspace's record, in any of its shapes.
    expect(ui.queryByText('End shift — QA Delta Corp')).toBeNull();
    expect(ui.queryByText('ON SHIFT')).toBeNull();
    expect(ui.queryByText('On shift')).toBeNull();
    expect(ui.getByText('No shifts recorded yet.')).toBeTruthy();
  });

  it('…but says, once, that a shift is open somewhere else', async () => {
    const ui = await mount();
    expect(ui.getByTestId('foreign-open-shift')).toBeTruthy();
    expect(ui.getByText(/You are on shift for QA Delta Corp/)).toBeTruthy();
  });

  it('no notice when the open session belongs to THIS workspace', async () => {
    const here = {...DELTA_OPEN, id: 'ses-echo', org_user_id: 'org-echo', org_name: 'QA Echo Ltd'};
    mockMyShifts.mockImplementation((opts?: {crossOrg?: boolean}) =>
      Promise.resolve({data: opts?.crossOrg ? [here] : [here]}));
    const ui = await mount();
    expect(ui.queryByTestId('foreign-open-shift')).toBeNull();
    expect(ui.getByText('On shift')).toBeTruthy();
  });

  /**
   * The notice names ANOTHER organisation — never this one.
   *
   * Isolated from the case above on purpose: there the open session is in the
   * SCOPED list too, so `!openShift` alone suppresses the notice and the org
   * comparison is never consulted. Here the scoped read has not caught up
   * (a lagging projection, a failed scoped read), which is exactly when a
   * missing comparison would tell a member they are on shift for the workspace
   * they are standing in.
   */
  it('never names the workspace the member is already in', async () => {
    const mine = {...DELTA_OPEN, id: 'ses-echo', org_user_id: 'org-echo', org_name: 'QA Echo Ltd'};
    mockMyShifts.mockImplementation((opts?: {crossOrg?: boolean}) =>
      Promise.resolve({data: opts?.crossOrg ? [mine] : []}));
    const ui = await mount();
    expect(ui.queryByTestId('foreign-open-shift')).toBeNull();
  });

  it('an old server that projects no org id raises no alarm either', async () => {
    // `org_user_id` absent = UNKNOWN. A notice built on a guess would fire on
    // every row an undeployed server sends.
    const unlabelled = {...DELTA_OPEN, org_user_id: undefined, org_name: undefined};
    mockMyShifts.mockImplementation((opts?: {crossOrg?: boolean}) =>
      Promise.resolve({data: opts?.crossOrg ? [unlabelled] : []}));
    const ui = await mount();
    expect(ui.queryByTestId('foreign-open-shift')).toBeNull();
  });

  it('no notice when nothing is open anywhere', async () => {
    mockMyShifts.mockResolvedValue({data: []});
    const ui = await mount();
    expect(ui.queryByTestId('foreign-open-shift')).toBeNull();
  });

  it('re-reads when the member enters a different workspace', async () => {
    await mount();
    const before = mockMyShifts.mock.calls.length;
    await act(async () => {
      useActiveWorkspace.getState().setActiveWorkspace(
        {org_id: 'org-delta', name: 'QA Delta Corp', role: 'employee'});
      await Promise.resolve();
    });
    expect(mockMyShifts.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('D1 — the OFFICER shell is untouched', () => {
  it('keeps the cross-org read, the row and the End-shift footer', async () => {
    mockInDeptShell = false;
    const ui = await mount();
    expect(mockMyShifts).toHaveBeenCalledWith({crossOrg: true});
    expect(mockMyTodayShift).toHaveBeenCalledWith({crossOrg: true});
    expect(ui.getByText('End shift — QA Delta Corp')).toBeTruthy();
    expect(ui.getByText('On shift')).toBeTruthy();
    expect(ui.queryByTestId('foreign-open-shift')).toBeNull();
  });

  it('…and so is a Departmental mount with no workspace chosen yet', async () => {
    // Fail-OPEN: a null context would scope the read to nothing at all, which
    // is the "some of my shifts" failure the 2026-08-12 decision refused.
    useActiveWorkspace.getState().setActiveWorkspace(null);
    const ui = await mount();
    expect(mockMyShifts).toHaveBeenCalledWith({crossOrg: true});
    expect(ui.getByText('On shift')).toBeTruthy();
  });
});
