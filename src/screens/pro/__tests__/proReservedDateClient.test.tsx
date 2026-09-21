/**
 * E2E-09 / E2E-07 — the client half of the reserved-date fixes.
 *
 * E2E-09: three "today"s competed over one reserved date — the client's UTC
 * `toISOString().slice(0,10)`, the server's todayGulf() (UTC+4) and Postgres
 * CURRENT_DATE. For a UAE user the mission-day tile stayed locked ~4 h into the
 * mission day and the calendar offered a day the server refused as date_in_past.
 * One helper now defines it on both sides.
 *
 * E2E-07: a SCHEDULED date could not be cancelled by anyone. The calendar gets
 * a RELEASE affordance for a reservation that has not started, and a released
 * date must stop painting the grid.
 */
import React from 'react';
import {render, fireEvent, act} from '@testing-library/react-native';
import SecureProCalendarScreen from '@screens/securepro/SecureProCalendarScreen';
import {todayGulf, GULF_UTC_OFFSET_HOURS} from '@screens/securepro/gulfDay';
import {secureProApi} from '@services/api';
import {Alert} from '@utils/alert';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn()}),
  useFocusEffect: (cb: () => void) => {
    const react = require('react');
    react.useEffect(cb, []);
  },
}));

jest.mock('@services/api', () => ({
  secureProApi: {
    missions: jest.fn(),
    requestMission: jest.fn(),
    cancelMission: jest.fn(),
  },
}));

jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));
jest.mock('@hooks/useProPlanGate', () => ({useProPlanGate: () => {}}));
jest.mock('@hooks/useBottomInset', () => ({
  useBottomInset: () => ({contentBottom: () => 110, bottomPad: () => 12}),
}));
jest.mock('@hooks/useKeyboardLayout', () => ({
  useKeyboardLayout: () => ({overlap: 0, visible: false, safeBottom: 0, bottomPad: (g = 0) => g}),
}));
jest.mock('@screens/securepro/useProAppRealtime', () => ({useProAppRealtime: () => {}}));

const APP = {
  id: 'app-1',
  status: 'ACTIVE',
  start_date: '2026-10-01',
  proposal: {coverage_start: '2026-10-01', coverage_end: '2026-10-31'},
};
jest.mock('@store/secureProStore', () => ({
  useSecureProStore: (sel: (s: unknown) => unknown) => sel({application: APP}),
}));
// B-852 — the calendar now reads the viewer's id to attribute a linked
// member's dates. This viewer is the plan holder and booked every fixture row
// (`requested_by: 'u1'`), so nothing here is labelled or filtered: the E2E-07 /
// E2E-09 cases assert exactly the rendering they always did.
jest.mock('@store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({user: {id: 'u1'}}),
}));

const mockMissions = secureProApi.missions as jest.Mock;
const mockCancel = secureProApi.cancelMission as jest.Mock;
const mockAlert = Alert.alert as unknown as jest.Mock;

/** 2026-10-04 20:00 UTC — already the 5th in the Gulf. */
const NOW_UTC_4TH_EVENING = Date.parse('2026-10-04T20:00:00.000Z');

const mission = (id: string, status: string, dates: string[]) => ({
  id, application_id: 'app-1', requested_by: 'u1', mission_dates: dates, note: null,
  status, assigned_team: [], ops_note: null, created_at: '2026-09-20T00:00:00.000Z',
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCancel.mockResolvedValue({data: {mission: mission('m1', 'CANCELLED', [])}});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('gulfDay.todayGulf — ONE canonical day (E2E-09)', () => {
  it('rolls over at 20:00 UTC, where the UTC day does not', () => {
    const t = Date.parse('2026-10-04T20:00:00.000Z');
    expect(todayGulf(t)).toBe('2026-10-05');
    expect(new Date(t).toISOString().slice(0, 10)).toBe('2026-10-04'); // the old, wrong answer
  });

  it('is still the previous day one minute earlier', () => {
    expect(todayGulf(Date.parse('2026-10-04T19:59:00.000Z'))).toBe('2026-10-04');
  });

  it('matches the server helper exactly — a fixed +4 with no DST', () => {
    expect(GULF_UTC_OFFSET_HOURS).toBe(4);
    const t = Date.parse('2026-07-04T21:30:00.000Z'); // northern summer: still +4
    expect(todayGulf(t)).toBe('2026-07-05');
  });
});

describe('SecureProCalendarScreen — the grid runs on the Gulf day (E2E-09)', () => {
  it('the Gulf day is already the 5th while UTC still says the 4th', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_UTC_4TH_EVENING);
    mockMissions.mockResolvedValue({data: {missions: []}});
    const {findByLabelText} = render(<SecureProCalendarScreen />);
    // Selecting the 4th is refused (it is past in the Gulf) while the tile for
    // the 5th is live — the pre-fix UTC "today" had these one day apart.
    expect(await findByLabelText('5 October')).toBeTruthy();
  });
});

describe('SecureProCalendarScreen — releasing a reserved date (E2E-07)', () => {
  it('a future reservation offers RELEASE and calls cancelMission on confirm', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_UTC_4TH_EVENING);
    mockMissions.mockResolvedValue({data: {missions: [mission('m1', 'SCHEDULED', ['2026-10-20'])]}});
    const {findByTestId} = render(<SecureProCalendarScreen />);

    fireEvent.press(await findByTestId('pro-mission-release-m1'));
    expect(mockAlert).toHaveBeenCalledWith(
      'Release these dates?', expect.any(String), expect.any(Array));

    // The confirm button — the destructive one, not "Keep".
    const buttons = mockAlert.mock.calls[0][2] as Array<{text: string; onPress?: () => void}>;
    await act(async () => { buttons.find(b => b.text === 'Release')!.onPress!(); });
    expect(mockCancel).toHaveBeenCalledWith('app-1', 'm1');
  });

  it('a reservation that includes TODAY is not client-releasable — ops owns the live day', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_UTC_4TH_EVENING);
    mockMissions.mockResolvedValue({data: {missions: [
      mission('m2', 'SCHEDULED', ['2026-10-05', '2026-10-06']),
    ]}});
    const {findByText, queryByTestId} = render(<SecureProCalendarScreen />);
    await findByText(/Scheduled from 05 Oct 2026 to 06 Oct 2026/);
    expect(queryByTestId('pro-mission-release-m2')).toBeNull();
  });

  it('a terminal reservation is not releasable either', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_UTC_4TH_EVENING);
    mockMissions.mockResolvedValue({data: {missions: [mission('m3', 'COMPLETED', ['2026-10-20'])]}});
    const {findByText, queryByTestId} = render(<SecureProCalendarScreen />);
    await findByText(/Completed on 20 Oct 2026/);
    expect(queryByTestId('pro-mission-release-m3')).toBeNull();
  });

  it('a CANCELLED reservation stops painting the calendar', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_UTC_4TH_EVENING);
    mockMissions.mockResolvedValue({data: {missions: [mission('m4', 'CANCELLED', ['2026-10-20'])]}});
    const {findByLabelText, queryByLabelText} = render(<SecureProCalendarScreen />);
    // Plain day label — no ", scheduled" suffix. Releasing a date that then
    // keeps painting the grid would just move the lie from ops to the client.
    expect(await findByLabelText('20 October')).toBeTruthy();
    expect(queryByLabelText('20 October, scheduled')).toBeNull();
  });

  it('a SCHEDULED reservation DOES paint it (the mutation control for the test above)', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_UTC_4TH_EVENING);
    mockMissions.mockResolvedValue({data: {missions: [mission('m5', 'SCHEDULED', ['2026-10-20'])]}});
    const {findByLabelText} = render(<SecureProCalendarScreen />);
    expect(await findByLabelText('20 October, scheduled')).toBeTruthy();
  });
});
