/**
 * B-814 (founder, 2026-09-07) — "the calendar always opens on August and we
 * are in September now. The calendar must always open in the month you're in."
 *
 * The pager state was `useState(0)`: the FIRST covered month, whatever the
 * date. RED-first: before the fix the render below titled "August 2026" with
 * today mocked to 2026-09-07.
 */
import React from 'react';
import {render, fireEvent} from '@testing-library/react-native';
import SecureProCalendarScreen from '@screens/securepro/SecureProCalendarScreen';
import {initialMonthIndex, monthsBetween} from '@screens/securepro/calendarMonths';
import {secureProApi} from '@services/api';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn()}),
  useFocusEffect: (cb: () => void) => {
    const react = require('react');
    react.useEffect(cb, []);
  },
}));
jest.mock('@services/api', () => ({
  secureProApi: {missions: jest.fn(), requestMission: jest.fn()},
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

// The founder's plan: 2026-08-14 → 2026-09-14 (two pages: August, September).
const APP = {
  id: 'app-1',
  status: 'ACTIVE',
  start_date: '2026-08-14',
  proposal: {coverage_start: '2026-08-14', coverage_end: '2026-09-14'},
};
jest.mock('@store/secureProStore', () => ({
  useSecureProStore: (sel: (s: unknown) => unknown) => sel({application: APP}),
}));
// B-852 — the viewer is the plan holder, so no attribution line and no filter
// chips: the pager keeps the exact layout these cases were written against.
jest.mock('@store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({user: {id: 'u1'}}),
}));

const mockMissions = secureProApi.missions as jest.Mock;

describe('initialMonthIndex — the page the calendar opens on', () => {
  const months = monthsBetween('2026-08-14', '2026-11-30'); // Aug Sep Oct Nov

  it('is the month containing today when today is inside the covered period', () => {
    expect(initialMonthIndex(months, '2026-09-07')).toBe(1);
    expect(initialMonthIndex(months, '2026-11-30')).toBe(3);
    expect(initialMonthIndex(months, '2026-08-14')).toBe(0);
  });

  it('clamps to the nearest edge when today is outside the period', () => {
    expect(initialMonthIndex(months, '2026-07-31')).toBe(0);   // not started yet
    expect(initialMonthIndex(months, '2027-01-02')).toBe(3);   // already over
  });

  it('is 0 for an empty or unparsable input (never NaN)', () => {
    expect(initialMonthIndex([], '2026-09-07')).toBe(0);
    expect(initialMonthIndex(months, 'garbage')).toBe(0);
  });
});

describe('SecureProCalendarScreen — opens on the month you are in', () => {
  let nowSpy: jest.SpyInstance<number, []>;
  beforeEach(() => {
    jest.clearAllMocks();
    mockMissions.mockResolvedValue({data: {missions: []}});
    // 2026-09-07 10:00 UTC — September in both UTC and the Gulf day.
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 7, 10));
  });
  afterEach(() => { nowSpy.mockRestore(); });

  it('titles the pager with the CURRENT month, not the first covered one', async () => {
    const {findByText, queryByText} = render(<SecureProCalendarScreen />);
    expect(await findByText('September 2026')).toBeTruthy();
    expect(queryByText('August 2026')).toBeNull();
  });

  it('the pager still steps back to the earlier covered month from there', async () => {
    const {findByText, getByLabelText} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');
    fireEvent.press(getByLabelText('Previous month'));
    expect(await findByText('August 2026')).toBeTruthy();
    fireEvent.press(getByLabelText('Next month'));
    expect(await findByText('September 2026')).toBeTruthy();
  });
});
