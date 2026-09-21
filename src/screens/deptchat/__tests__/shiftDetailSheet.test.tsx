/**
 * B-855 (founder 2026-09-11) — _"each shift is shown but when we expand each
 * shift we should see which users are assigned, their location, and all required
 * information for each worker with their picture; click to view the picture"_.
 *
 * A RENDER test, because the interesting failures are all wiring: a `Card` is a
 * button only when it carries `onPress`, and the rest of the sheet is gated on
 * server fields whose ABSENCE (an undeployed server answering 200 with the old
 * two-field shape) must degrade rather than lie.
 */
import React from 'react';
import {render, fireEvent, waitFor} from '@testing-library/react-native';
import type {ShiftAssigneeDto, ShiftDto} from '@services/api';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({navigate: mockNavigate, goBack: jest.fn(), getParent: () => undefined, getState: () => ({routeNames: []})}),
  useRoute: () => ({params: undefined}),
  useFocusEffect: (cb: () => void | (() => void)) => { const R = require('react'); R.useEffect(() => cb(), []); },
}));
jest.mock('@hooks/useKeyboardLayout', () => ({
  useKeyboardLayout: () => ({overlap: 0, safeBottom: 0, bottomPad: () => 0}),
  useKeyboardOverlap: () => 0,
  useRevealOnKeyboard: () => jest.fn(),
}));
jest.mock('@/modules/messenger/ui/AmbientBg', () => ({AmbientBg: 'AmbientBg'}));
jest.mock('react-native-geolocation-service', () => ({getCurrentPosition: jest.fn(), requestAuthorization: jest.fn()}));
jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
const AUTH_STATE = {user: {id: 'u1', is_org_manager: true, account_kind: 'agency'}};
jest.mock('@store/authStore', () => {
  const useAuthStore = (sel: (s: unknown) => unknown) => sel(AUTH_STATE);
  useAuthStore.getState = () => AUTH_STATE;
  return {useAuthStore};
});
// No network place resolution in a unit test — the session line must read off
// the STORED name, not wait for Mapbox.
jest.mock('../placeName', () => ({
  ...jest.requireActual('../placeName'),
  resolvePlaceName: jest.fn().mockResolvedValue(null),
}));

const mockListAssignments = jest.fn();
const mockListShifts = jest.fn();
jest.mock('@services/api', () => ({
  attendanceApi: {
    listShiftAssignments: (...a: unknown[]) => mockListAssignments(...a),
    listShifts: (...a: unknown[]) => mockListShifts(...a),
    archiveShift: jest.fn().mockResolvedValue({data: {}}),
    sessionPhoto: jest.fn().mockResolvedValue({data: {mime: 'image/jpeg', captured_at: null, data_url: 'data:,'}}),
  },
  orgApi: {workspaceSettings: jest.fn().mockRejectedValue(new Error('none')), listCpos: jest.fn().mockResolvedValue({data: []})},
}));

import {ShiftDetailSheet} from '../ShiftDetailSheet';
import {initialsFor, sessionLine} from '../AssigneeRow';
import ShiftManagementScreen from '../ShiftManagementScreen';

const SHIFT: ShiftDto = {
  id: 'sh1', org_user_id: 'o1', department: 'Ops', site_label: 'Gate B',
  site_lat: 25.2, site_lng: 55.27, approved_radius_m: 150,
  start_at: '2026-09-11T06:00:00.000Z', end_at: '2026-09-11T14:00:00.000Z',
  created_by: 'm1', archived_at: null, created_at: '2026-09-01T00:00:00.000Z',
  assigned_count: 2,
};

const OPEN_ROW: ShiftAssigneeDto = {
  cpo_user_id: 'c1', display_name: 'Dana Rivers', avatar_url: null,
  call_sign: 'BR-12', department: 'Ops', member_status: 'active',
  session: {
    status: 'open', id: 'ses1', clock_in_at: '2026-09-11T06:04:00.000Z',
    clock_in_lat: 25.2005, clock_in_lng: 55.2701, clock_in_place: 'Gate B, Dubai',
    clock_out_at: null, within_radius: true, distance_m: 120, has_photo: true,
  },
  last_ping: null,
};

/** What an UNDEPLOYED server still answers with — 200, two fields, no `session`. */
const OLD_SERVER_ROW = {cpo_user_id: 'c9', display_name: 'Legacy Person'} as ShiftAssigneeDto;

beforeEach(() => {
  mockNavigate.mockReset();
  mockListShifts.mockReset();
  mockListAssignments.mockReset();
  mockListShifts.mockResolvedValue({data: [SHIFT]});
  mockListAssignments.mockResolvedValue({data: {assignments: [OPEN_ROW]}});
});

describe('B-855 — the shift row is a door', () => {
  it('a shift card carries onPress, so tapping it opens the detail (a Card without onPress is not a button)', async () => {
    const ui = render(<ShiftManagementScreen />);
    await waitFor(() => expect(mockListShifts).toHaveBeenCalled());
    const card = await ui.findByLabelText(/Gate B.*Open shift details/s);
    fireEvent.press(card);
    await waitFor(() => expect(mockListAssignments).toHaveBeenCalledWith('sh1'));
    expect(await ui.findByText('Dana Rivers')).toBeTruthy();
  });

  it('a PAST shift opens too — "who turned up" is what a finished shift is asked', async () => {
    mockListShifts.mockResolvedValue({data: [{...SHIFT, id: 'old', site_label: 'Old Post',
      start_at: '2020-01-01T06:00:00.000Z', end_at: '2020-01-01T14:00:00.000Z'}]});
    const ui = render(<ShiftManagementScreen />);
    const card = await ui.findByLabelText(/Old Post.*Open shift details/s);
    fireEvent.press(card);
    await waitFor(() => expect(mockListAssignments).toHaveBeenCalledWith('old'));
  });
});

describe('B-855 — the detail sheet', () => {
  it('does NOT fetch while closed, and fetches on open (one sheet per list screen)', async () => {
    const ui = render(<ShiftDetailSheet open={false} shift={SHIFT} onClose={jest.fn()} />);
    expect(mockListAssignments).not.toHaveBeenCalled();
    ui.rerender(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    await waitFor(() => expect(mockListAssignments).toHaveBeenCalledWith('sh1'));
  });

  it('renders the person, the call sign and the department, and the session line', async () => {
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    expect(await ui.findByText('Dana Rivers')).toBeTruthy();
    expect(ui.getByText('BR-12 · Ops')).toBeTruthy();
    expect(ui.getByText(/Clocked in .*Gate B.*120 m from site/)).toBeTruthy();
  });

  it('"Open on map" CLOSES the sheet first — the map is pushed UNDER this Modal', async () => {
    const onClose = jest.fn();
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={onClose} />);
    fireEvent.press(await ui.findByTestId('assignee-map-c1'));
    expect(onClose).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('CheckInMap', expect.objectContaining({
      lat: 25.2005, lng: 55.2701, siteLat: 25.2, radiusM: 150, distanceM: 120, withinRadius: true,
    }));
  });

  it('the check-in photo is TAP-ONLY and keyed by SESSION id (every view is audited)', async () => {
    const api = jest.requireMock('@services/api') as {attendanceApi: {sessionPhoto: jest.Mock}};
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    await ui.findByText('Dana Rivers');
    expect(api.attendanceApi.sessionPhoto).not.toHaveBeenCalled();
    fireEvent.press(ui.getByTestId('assignee-photo-c1'));
    await waitFor(() => expect(api.attendanceApi.sessionPhoto).toHaveBeenCalledWith('ses1'));
  });

  it('hides the photo door when the row has no viewable photo', async () => {
    mockListAssignments.mockResolvedValue({data: {assignments: [
      {...OPEN_ROW, session: {...OPEN_ROW.session!, has_photo: false}},
    ]}});
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    await ui.findByText('Dana Rivers');
    expect(ui.queryByTestId('assignee-photo-c1')).toBeNull();
  });

  it('a removed member still LISTS, with a chip — they worked the shift', async () => {
    mockListAssignments.mockResolvedValue({data: {assignments: [
      {...OPEN_ROW, member_status: 'suspended'},
    ]}});
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    expect(await ui.findByText('No longer in this workspace')).toBeTruthy();
    expect(ui.getByText('Dana Rivers')).toBeTruthy();
  });

  it('A9 — an OLD server (200, two fields) shows the person and NO invented session line', async () => {
    mockListAssignments.mockResolvedValue({data: {assignments: [OLD_SERVER_ROW]}});
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    expect(await ui.findByText('Legacy Person')).toBeTruthy();
    expect(ui.queryByText('Not checked in for this shift')).toBeNull();
    // …and an absent member_status is "unknown", never "removed".
    expect(ui.queryByText('No longer in this workspace')).toBeNull();
    expect(ui.queryByTestId('assignee-map-c9')).toBeNull();
  });

  it('surfaces the server cap as "+N more" rather than silently truncating', async () => {
    mockListAssignments.mockResolvedValue({data: {assignments: [OPEN_ROW], more: 43}});
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    expect(await ui.findByText('+43 more')).toBeTruthy();
  });
});

describe('B-855 — the row helpers', () => {
  it('sessionLine distinguishes "old server" (null) from "no session yet"', () => {
    expect(sessionLine({session: undefined}, null)).toBeNull();
    expect(sessionLine({session: null}, null)).toBe('Not checked in for this shift');
    expect(sessionLine({session: {...OPEN_ROW.session!, status: 'not_started'}}, null))
      .toBe('Not checked in for this shift');
  });

  it('sessionLine names the clock-out on a closed session', () => {
    const line = sessionLine(
      {session: {...OPEN_ROW.session!, status: 'closed', clock_out_at: '2026-09-11T14:02:00.000Z'}},
      'Gate B',
    );
    expect(line).toMatch(/Clocked in/);
    expect(line).toMatch(/clocked out/);
  });

  it('initials fall back through display_name → call_sign → "Removed member"', () => {
    expect(initialsFor({display_name: 'Dana Rivers', call_sign: 'BR-12'})).toBe('DR');
    expect(initialsFor({display_name: null, call_sign: 'BR-12'})).toBe('B1');
    expect(initialsFor({display_name: null, call_sign: null})).toBe('RM');
  });
});
