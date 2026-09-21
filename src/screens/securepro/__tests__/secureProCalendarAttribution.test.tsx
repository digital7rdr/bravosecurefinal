/**
 * B-852 (founder, 2026-09-11) — "Root sees all, labelled; members see own."
 *
 * The screen half of the attribution work. The holder reads the coverage
 * calendar as a PLAN overview, so every linked member's protection dates are
 * visible but named ("Booked by Jack Ryan") and filterable by person. A member
 * only ever receives their own rows (server, P1/D1) — and never gets offered a
 * RELEASE button on a mission the server would refuse to cancel (D2/D5).
 *
 * RED before the fix: no chip row existed, no row or sheet card named a
 * requester, every note was captioned "Your note" whoever wrote it, and RELEASE
 * rendered on every releasable mission regardless of who booked it.
 */
import React from 'react';
import {render, fireEvent, within, act} from '@testing-library/react-native';
import SecureProCalendarScreen from '@screens/securepro/SecureProCalendarScreen';
import SecureProMissionsScreen from '@screens/securepro/SecureProMissionsScreen';
import {secureProApi, type ProPlanMission} from '@services/api';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn()}),
  useFocusEffect: (cb: () => void) => {
    const react = require('react');
    react.useEffect(cb, []);
  },
}));
jest.mock('@services/api', () => ({
  secureProApi: {missions: jest.fn(), requestMission: jest.fn(), cancelMission: jest.fn()},
}));
jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));
jest.mock('@hooks/useProPlanGate', () => ({useProPlanGate: () => {}}));
jest.mock('@hooks/useBottomInset', () => ({
  useBottomInset: () => ({contentBottom: () => 110, bottomPad: () => 12}),
}));
jest.mock('@hooks/useKeyboardLayout', () => ({
  useKeyboardLayout: () => ({overlap: 0, visible: false, safeBottom: 0, bottomPad: (g = 0) => g}),
}));
// The screen's own refetch trigger, captured so a test can play a second
// server answer through the exact path realtime uses.
const mockRealtime: {cb: (() => void) | null} = {cb: null};
jest.mock('@screens/securepro/useProAppRealtime', () => ({
  useProAppRealtime: (_id: unknown, cb: () => void) => { mockRealtime.cb = cb; },
}));

const HOLDER = '11111111-1111-4111-8111-1111111111aa';
const JACK   = '22222222-2222-4222-8222-2222222222bb';

// `mock`-prefixed so the jest.mock factories below may close over them.
const mockApp: {current: Record<string, unknown>} = {current: {}};
const mockSelf: {current: string | undefined} = {current: undefined};

jest.mock('@store/secureProStore', () => ({
  useSecureProStore: (sel: (s: unknown) => unknown) => sel({application: mockApp.current}),
}));
jest.mock('@store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({user: {id: mockSelf.current}}),
}));

const BASE_APP = {
  id: 'app-1',
  status: 'ACTIVE',
  start_date: '2026-09-01',
  proposal: {coverage_start: '2026-09-01', coverage_end: '2026-09-30'},
};

const mockMissions = secureProApi.missions as jest.Mock;

const mission = (
  id: string,
  requested_by: string | null,
  dates: string[],
  extra: Partial<ProPlanMission> = {},
): ProPlanMission => ({
  id,
  application_id: 'app-1',
  requested_by,
  mission_dates: dates,
  note: null,
  status: 'SCHEDULED',
  assigned_team: [],
  ops_note: null,
  created_at: '2026-09-01T00:00:00.000Z',
  ...extra,
});

const OWN  = mission('own-1', HOLDER, ['2026-09-10'], {note: 'Airport run'});
const JACKS = mission('jack-1', JACK, ['2026-09-20'], {
  note: 'School pickup', requested_by_name: 'Jack Ryan',
});

let nowSpy: jest.SpyInstance<number, []>;
beforeEach(() => {
  jest.clearAllMocks();
  mockApp.current = {...BASE_APP};
  mockSelf.current = HOLDER;
  mockRealtime.cb = null;
  mockMissions.mockResolvedValue({data: {missions: [OWN, JACKS]}});
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 7, 10));
});

/** Play another server answer through the screen's own refetch path. */
async function refetch(missions: ProPlanMission[]) {
  mockMissions.mockResolvedValue({data: {missions}});
  await act(async () => { mockRealtime.cb?.(); });
}
afterEach(() => { nowSpy.mockRestore(); });

describe('SecureProCalendarScreen — the holder sees whose dates these are', () => {
  it('S1 renders a chip per requester and names only the OTHER person\'s rows', async () => {
    const {findByText, getByTestId, queryByText} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');

    expect(getByTestId('pro-requester-chip-all')).toBeTruthy();
    expect(getByTestId('pro-requester-chip-self')).toBeTruthy();
    expect(getByTestId(`pro-requester-chip-${JACK}`)).toBeTruthy();
    expect(within(getByTestId(`pro-requester-chip-${JACK}`)).getByText('Jack Ryan')).toBeTruthy();

    expect(within(getByTestId('pro-mission-row-jack-1')).getByText('Booked by Jack Ryan')).toBeTruthy();
    expect(within(getByTestId('pro-mission-row-own-1')).queryByText(/^Booked by/)).toBeNull();
    expect(queryByText('Booked by you')).toBeNull();
  });

  it('S2 the chips are accessible buttons that report their selection', async () => {
    const {findByText, getByTestId} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');

    const all = getByTestId('pro-requester-chip-all');
    expect(all.props.accessibilityRole).toBe('button');
    expect(all.props.accessibilityState).toEqual(expect.objectContaining({selected: true}));
    expect(getByTestId('pro-requester-chip-self').props.accessibilityState)
      .toEqual(expect.objectContaining({selected: false}));
  });

  it('S3 picking a member narrows the REQUESTS list, the painted grid and the month chips', async () => {
    const {findByText, getByTestId, queryByTestId, getByLabelText, queryByLabelText} =
      render(<SecureProCalendarScreen />);
    await findByText('September 2026');

    expect(getByLabelText('10 September, scheduled')).toBeTruthy();
    expect(getByLabelText('20 September, scheduled')).toBeTruthy();
    expect(within(getByTestId('pro-month-chip-0')).getByText('Sep · 2')).toBeTruthy();

    fireEvent.press(getByTestId(`pro-requester-chip-${JACK}`));

    expect(getByTestId('pro-mission-row-jack-1')).toBeTruthy();
    expect(queryByTestId('pro-mission-row-own-1')).toBeNull();
    expect(queryByLabelText('10 September, scheduled')).toBeNull();
    expect(getByLabelText('10 September')).toBeTruthy();
    expect(getByLabelText('20 September, scheduled')).toBeTruthy();
    expect(within(getByTestId('pro-month-chip-0')).getByText('Sep · 1')).toBeTruthy();
    expect(getByTestId(`pro-requester-chip-${JACK}`).props.accessibilityState)
      .toEqual(expect.objectContaining({selected: true}));

    fireEvent.press(getByTestId('pro-requester-chip-self'));
    expect(getByTestId('pro-mission-row-own-1')).toBeTruthy();
    expect(queryByTestId('pro-mission-row-jack-1')).toBeNull();
  });

  it('S4 a one-requester plan renders NO chip row at all', async () => {
    mockMissions.mockResolvedValue({data: {missions: [OWN]}});
    const {findByText, queryByTestId} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');
    expect(queryByTestId('pro-requester-chip-all')).toBeNull();
    expect(queryByTestId('pro-requester-chip-self')).toBeNull();
  });

  it('S5 the detail sheet names the requester and stops calling their note "Your note"', async () => {
    const {findByText, getByTestId} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');

    fireEvent.press(getByTestId('pro-mission-row-jack-1'));
    const card = within(getByTestId('pro-day-mission-jack-1'));
    expect(card.getByText('Booked by Jack Ryan')).toBeTruthy();
    expect(card.getByText('Note')).toBeTruthy();
    expect(card.queryByText('Your note')).toBeNull();

    fireEvent.press(getByTestId('pro-day-sheet-close'));
    fireEvent.press(getByTestId('pro-mission-row-own-1'));
    const own = within(getByTestId('pro-day-mission-own-1'));
    expect(own.getByText('Your note')).toBeTruthy();
    expect(own.queryByText(/^Booked by/)).toBeNull();
  });

  it('S6 the HOLDER may release anyone\'s dates — both rows keep their button', async () => {
    const {findByText, getByTestId} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');
    expect(getByTestId('pro-mission-release-own-1')).toBeTruthy();
    expect(getByTestId('pro-mission-release-jack-1')).toBeTruthy();
  });

  it('S10 each chip says what it does, not just whose name is on it', async () => {
    const {findByText, getByTestId} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');
    expect(getByTestId('pro-requester-chip-all').props.accessibilityLabel)
      .toBe('Show all dates');
    expect(getByTestId('pro-requester-chip-self').props.accessibilityLabel)
      .toBe('Show dates you booked');
    expect(getByTestId(`pro-requester-chip-${JACK}`).props.accessibilityLabel)
      .toBe('Show dates booked by Jack Ryan');
  });

  it('S11 SELECT MODE always paints every reserved day — a filter must never hide a double booking', async () => {
    const {findByText, getByTestId, getByLabelText, queryByTestId} =
      render(<SecureProCalendarScreen />);
    await findByText('September 2026');

    fireEvent.press(getByTestId(`pro-requester-chip-${JACK}`));
    expect(getByLabelText('10 September')).toBeTruthy();        // holder's own day hidden

    fireEvent.press(getByLabelText('Request protection dates'));

    // The 10th is reserved. If the Jack filter survived into select mode it
    // would look free, and the client would book a date they already hold.
    expect(getByLabelText('10 September, scheduled')).toBeTruthy();
    expect(getByLabelText('20 September, scheduled')).toBeTruthy();
    // …and the chip row is gone, so it cannot be re-applied mid-selection.
    expect(queryByTestId(`pro-requester-chip-${JACK}`)).toBeNull();
  });

  it('S12 a filter whose rider leaves the plan is CLEARED, not parked until they come back', async () => {
    const {findByText, getByTestId, queryByTestId} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');

    fireEvent.press(getByTestId(`pro-requester-chip-${JACK}`));
    expect(queryByTestId('pro-mission-row-own-1')).toBeNull();

    // Jack's request is released — his chip disappears and the view opens up.
    await refetch([OWN]);
    expect(getByTestId('pro-mission-row-own-1')).toBeTruthy();
    expect(queryByTestId(`pro-requester-chip-${JACK}`)).toBeNull();

    // He books again. The stale key must NOT snap the calendar back to his dates.
    await refetch([OWN, JACKS]);
    expect(getByTestId('pro-mission-row-own-1')).toBeTruthy();
    expect(getByTestId('pro-mission-row-jack-1')).toBeTruthy();
    expect(getByTestId('pro-requester-chip-all').props.accessibilityState)
      .toEqual(expect.objectContaining({selected: true}));
  });
});

describe('SecureProCalendarScreen — a MEMBER riding the holder\'s plan', () => {
  beforeEach(() => {
    mockSelf.current = JACK;
    mockApp.current = {...BASE_APP, via_owner: {name: 'Baine Kriel'}};
  });

  it('S7 never offers RELEASE on a mission the member did not book (the server refuses it)', async () => {
    const {findByText, getByTestId, queryByTestId} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');

    expect(getByTestId('pro-mission-release-jack-1')).toBeTruthy();
    expect(queryByTestId('pro-mission-release-own-1')).toBeNull();

    fireEvent.press(getByTestId('pro-mission-row-own-1'));
    expect(queryByTestId('pro-day-release-own-1')).toBeNull();
  });

  it('S8 sees the holder\'s row labelled, and their own unlabelled', async () => {
    const {findByText, getByTestId} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');
    expect(within(getByTestId('pro-mission-row-jack-1')).queryByText(/^Booked by/)).toBeNull();
    expect(within(getByTestId('pro-mission-row-own-1')).getByText('Booked by a member')).toBeTruthy();
  });

  it('S13 a LEGACY row (requested_by NULL) is the holder\'s — labelled, and no RELEASE', async () => {
    // The member cannot know the holder's id, so a NULL owner used to collapse
    // to "mine": the button rendered and the server answered 403.
    const LEGACY = mission('legacy-1', null, ['2026-09-25'], {
      note: 'Pre-ride-along booking', requested_by_name: 'Baine Kriel',
    });
    mockMissions.mockResolvedValue({data: {missions: [LEGACY, JACKS]}});
    const {findByText, getByTestId, queryByTestId} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');

    expect(within(getByTestId('pro-mission-row-legacy-1')).getByText('Booked by Baine Kriel'))
      .toBeTruthy();
    expect(queryByTestId('pro-mission-release-legacy-1')).toBeNull();
    expect(getByTestId('pro-mission-release-jack-1')).toBeTruthy();

    fireEvent.press(getByTestId('pro-mission-row-legacy-1'));
    expect(within(getByTestId('pro-day-mission-legacy-1')).getByText('Note')).toBeTruthy();
    expect(queryByTestId('pro-day-release-legacy-1')).toBeNull();
  });
});

describe('SecureProMissionsScreen — the sibling list carries the same line', () => {
  it('S9 names the other requester and leaves the viewer\'s own card unlabelled', async () => {
    const {findByTestId, getByTestId, queryByText} = render(<SecureProMissionsScreen />);
    await findByTestId('pro-missions-card-jack-1');

    expect(within(getByTestId('pro-missions-card-jack-1')).getByText('Booked by Jack Ryan')).toBeTruthy();
    expect(within(getByTestId('pro-missions-card-own-1')).queryByText(/^Booked by/)).toBeNull();
    expect(queryByText('Booked by you')).toBeNull();
  });
});
