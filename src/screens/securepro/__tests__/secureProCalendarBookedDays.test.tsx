/**
 * B-821 (founder, 2026-09-07, screenshot of the September page) — "user booked
 * 10 different bookings on different days, those days are not marked to show
 * these are the booked days. And if I click on those days the user should be
 * able to see all the necessary information — show all the detail that we can."
 *
 * Fixture = the founder's own plan (application 97fd0219, coverage
 * 2026-08-19 → 2026-09-19): ten COMPLETED days across 20–29 August, two
 * COMPLETED and two DECLINED missions on 2 September.
 *
 * RED before the fix: T1 (a COMPLETED day carried no status word at all — the
 * grid only painted SCHEDULED/REQUESTED), T2 (no "Completed" legend entry, no
 * booked-days chips), T3 (nothing on the grid was tappable — there was no
 * detail sheet), T4 (the REQUESTS list was `missions.slice(0, 6)`, so the
 * oldest of the seven rows was silently dropped), T5/T6/T8/T9/T10 (same three
 * causes). T7 pins that select mode is unchanged by any of it.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import React from 'react';
import {render, fireEvent, within} from '@testing-library/react-native';
import SecureProCalendarScreen from '@screens/securepro/SecureProCalendarScreen';
import {
  paintedDateStatus, missionsByDate, paintedDaysByMonth, MISSION_STATUS_TONE,
} from '@screens/securepro/calendarMissions';
import {monthsBetween} from '@screens/securepro/calendarMonths';
import {secureProApi, type ProPlanMission} from '@services/api';
import {Alert} from '@utils/alert';

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
jest.mock('@screens/securepro/useProAppRealtime', () => ({useProAppRealtime: () => {}}));

// The founder's plan: 2026-08-19 → 2026-09-19 (two pages: August, September).
const APP = {
  id: 'app-1',
  status: 'ACTIVE',
  start_date: '2026-08-19',
  proposal: {coverage_start: '2026-08-19', coverage_end: '2026-09-19'},
};
jest.mock('@store/secureProStore', () => ({
  useSecureProStore: (sel: (s: unknown) => unknown) => sel({application: APP}),
}));
// B-852 — the viewer IS the plan holder and requested every fixture mission
// (`requested_by: 'u1'`), so nothing here is attributed and no filter chips
// appear: these cases assert exactly the rendering they did before.
jest.mock('@store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({user: {id: 'u1'}}),
}));

const mockMissions = secureProApi.missions as jest.Mock;
const mockAlert = Alert.alert as jest.Mock;

const mission = (
  id: string,
  status: ProPlanMission['status'],
  dates: string[],
  extra: Partial<ProPlanMission> = {},
): ProPlanMission => ({
  id, application_id: 'app-1', requested_by: 'u1', mission_dates: dates, note: null,
  status, assigned_team: [], ops_note: null, created_at: '2026-08-20T00:00:00.000Z',
  ...extra,
});

const FIXTURE: ProPlanMission[] = [
  mission('f12b32d8', 'COMPLETED', ['2026-09-02'], {
    created_at: '2026-09-02T07:28:34.140Z',
    assigned_team: [{role: 'Close Protection Officer', count: 1, label: 'Corne Agent'}],
  }),
  mission('51f41c42', 'COMPLETED', ['2026-09-02'], {
    created_at: '2026-09-02T04:04:44.100Z',
    note: 'Movement to Dubai\nhttps://maps.app.goo.gl/GcVtRYyGpn4HxJcU9',
    assigned_team: [{role: 'Close Protection Officer', count: 1, label: 'Corne Agent'}],
  }),
  mission('c2385776', 'DECLINED', ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'], {
    created_at: '2026-08-26T19:38:56.706Z',
    note: 'I am going to thailand',
    ops_note: 'Team unavailable on those dates',
  }),
  mission('4906690e', 'DECLINED', ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'], {
    created_at: '2026-08-19T09:56:23.707Z',
    ops_note: 'Declined by ops',
  }),
  mission('964d04de', 'COMPLETED', [
    '2026-08-22', '2026-08-23', '2026-08-24', '2026-08-25',
    '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29',
  ], {
    created_at: '2026-08-03T16:14:16.828Z',
    note: '2 CPOs',
    assigned_team: [{role: 'Close Protection Officer', count: 4, label: 'Roger, Ranger Big Man, Ranak Debnath, Leon Ward'}],
  }),
  mission('c6a16efb', 'COMPLETED', ['2026-08-21'], {
    created_at: '2026-08-03T16:11:23.712Z',
    note: 'Extra CPO',
    assigned_team: [{role: 'Close Protection Officer', count: 1, label: 'Leon Ward'}],
  }),
  mission('fb45c605', 'COMPLETED', ['2026-08-20'], {
    created_at: '2026-08-03T16:11:05.452Z',
    note: 'Helicopter',
    assigned_team: [{role: 'Close Protection Officer', count: 2, label: 'Agent 2, Jane Kruger'}],
  }),
];

describe('calendarMissions — the pure model', () => {
  it('paints SCHEDULED over COMPLETED over REQUESTED, and never paints DECLINED/CANCELLED', () => {
    const painted = paintedDateStatus(FIXTURE);
    expect(painted.get('2026-08-26')).toBe('COMPLETED');
    expect(painted.get('2026-09-02')).toBe('COMPLETED');
    expect(painted.has('2026-09-03')).toBe(false); // declined only
    expect(painted.size).toBe(11); // ten August days + 2 September

    const mixed = paintedDateStatus([
      mission('a', 'REQUESTED', ['2026-10-01']),
      mission('b', 'COMPLETED', ['2026-10-01']),
      mission('c', 'SCHEDULED', ['2026-10-01']),
      mission('d', 'CANCELLED', ['2026-10-02']),
    ]);
    expect(mixed.get('2026-10-01')).toBe('SCHEDULED');
    expect(mixed.has('2026-10-02')).toBe(false);
    expect(paintedDateStatus([
      mission('a', 'COMPLETED', ['2026-10-01']),
      mission('b', 'REQUESTED', ['2026-10-01']),
    ]).get('2026-10-01')).toBe('COMPLETED');
  });

  it('indexes EVERY status by date, ranked then newest-first inside a day', () => {
    const byDate = missionsByDate(FIXTURE);
    expect(byDate.get('2026-09-02')?.map(m => m.id))
      .toEqual(['f12b32d8', '51f41c42', 'c2385776', '4906690e']);
    expect(byDate.get('2026-09-03')?.map(m => m.id)).toEqual(['c2385776', '4906690e']);
    expect(byDate.get('2026-08-26')?.map(m => m.id)).toEqual(['964d04de']);
    expect(byDate.has('2026-08-18')).toBe(false);
  });

  it('counts painted days per pager page and drops the empty months', () => {
    const months = monthsBetween('2026-08-19', '2026-09-19');
    expect(paintedDaysByMonth(paintedDateStatus(FIXTURE), months))
      .toEqual([{ix: 0, count: 10}, {ix: 1, count: 1}]);
    expect(paintedDaysByMonth(new Map(), months)).toEqual([]);
    expect(paintedDaysByMonth(
      paintedDateStatus([mission('x', 'SCHEDULED', ['2026-09-15'])]),
      months,
    )).toEqual([{ix: 1, count: 1}]);
  });
});

describe('SecureProCalendarScreen — booked days are marked and open their detail', () => {
  let nowSpy: jest.SpyInstance<number, []>;
  beforeEach(() => {
    jest.clearAllMocks();
    mockMissions.mockResolvedValue({data: {missions: FIXTURE}});
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 7, 10));
  });
  afterEach(() => { nowSpy.mockRestore(); });

  it('T1 marks every booked day with its own status, and leaves declined days unpainted', async () => {
    const {findByText, getByLabelText, queryByLabelText} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');

    expect(getByLabelText('2 September, completed')).toBeTruthy();
    expect(getByLabelText('3 September')).toBeTruthy();          // declined only — unpainted
    expect(queryByLabelText('3 September, completed')).toBeNull();

    fireEvent.press(getByLabelText('Previous month'));
    await findByText('August 2026');
    for (const d of [20, 21, 22, 23, 24, 25, 26, 27, 28, 29]) {
      expect(getByLabelText(`${d} August, completed`)).toBeTruthy();
    }
    expect(getByLabelText('18 August')).toBeTruthy();
  });

  it('T2 legend names Completed and the summary chips count the booked days per month', async () => {
    const {findByText, getByText} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');
    expect(getByText('Completed')).toBeTruthy();
    expect(getByText('Aug · 10')).toBeTruthy();
    expect(getByText('Sep · 1')).toBeTruthy();
  });

  it('T3 tapping a booked day opens the full detail for that day', async () => {
    const {findByText, getByLabelText, getByTestId, getByText} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');
    fireEvent.press(getByLabelText('Previous month'));
    await findByText('August 2026');

    fireEvent.press(getByTestId('pro-day-2026-08-26'));

    expect(getByTestId('pro-day-sheet')).toBeTruthy();
    expect(getByText('Wed 26 Aug 2026')).toBeTruthy();
    expect(within(getByTestId('pro-day-mission-964d04de')).getByText('Completed')).toBeTruthy();
    expect(getByText('8 dates · 22 Aug 2026 to 29 Aug 2026')).toBeTruthy();
    expect(getByText('Roger, Ranger Big Man, Ranak Debnath, Leon Ward')).toBeTruthy();
    expect(getByText('2 CPOs')).toBeTruthy();
    expect(getByText('Requested on Mon 03 Aug 2026')).toBeTruthy();
  });

  it('T4 the REQUESTS list renders every mission — no silent cap', async () => {
    const {findByText, getByTestId} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');
    for (const mi of FIXTURE) {
      expect(getByTestId(`pro-mission-row-${mi.id}`)).toBeTruthy();
    }
    // The 7th (oldest) row — the one `.slice(0, 6)` dropped.
    expect(await findByText(/Completed on 20 Aug 2026/)).toBeTruthy();
  });

  it('T5 pressing a REQUESTS row jumps the pager to its month and opens its detail', async () => {
    const {findByText, getByTestId, getByText} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');

    fireEvent.press(getByTestId('pro-mission-row-fb45c605'));

    expect(await findByText('August 2026')).toBeTruthy();
    expect(getByTestId('pro-day-sheet')).toBeTruthy();
    expect(getByText('Helicopter')).toBeTruthy();
  });

  it('T6 a declined day explains itself, and Close dismisses the sheet', async () => {
    const {findByText, getByTestId, queryByTestId, getByText, getAllByText} =
      render(<SecureProCalendarScreen />);
    await findByText('September 2026');

    fireEvent.press(getByTestId('pro-day-2026-09-03'));

    expect(getAllByText('Declined')).toHaveLength(2);
    expect(getByText('Team unavailable on those dates')).toBeTruthy();
    expect(getByText('Declined by ops')).toBeTruthy();

    fireEvent.press(getByTestId('pro-day-sheet-close'));
    expect(queryByTestId('pro-day-sheet')).toBeNull();
  });

  it('T7 select mode still selects and never opens the sheet', async () => {
    const {findByText, getByLabelText, queryByTestId, getByText} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');

    fireEvent.press(getByLabelText('Request protection dates'));
    fireEvent.press(getByLabelText('10 September'));

    expect(queryByTestId('pro-day-sheet')).toBeNull();
    expect(getByText(/Selected · 1/)).toBeTruthy();
  });

  it('T8 a booked-days chip pages the calendar to that month', async () => {
    const {findByText, getByTestId} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');
    fireEvent.press(getByTestId('pro-month-chip-0'));
    expect(await findByText('August 2026')).toBeTruthy();
  });

  it('T9 the row RELEASE button still releases and does not open the sheet', async () => {
    mockMissions.mockResolvedValue({data: {missions: [
      mission('sched-1', 'SCHEDULED', ['2026-09-15'], {created_at: '2026-09-01T00:00:00.000Z'}),
    ]}});
    const {findByText, getByTestId, queryByTestId} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');

    fireEvent.press(getByTestId('pro-mission-release-sched-1'));

    expect(mockAlert).toHaveBeenCalledWith(
      'Release these dates?',
      expect.stringContaining('15 Sep 2026'),
      expect.any(Array),
    );
    expect(queryByTestId('pro-day-sheet')).toBeNull();
  });

  it('T10 a day with several missions lists them all, live first then declined', async () => {
    const {findByText, getByTestId, getAllByTestId} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');

    fireEvent.press(getByTestId('pro-day-2026-09-02'));

    expect(getAllByTestId(/^pro-day-mission-/).map(n => n.props.testID)).toEqual([
      'pro-day-mission-f12b32d8',
      'pro-day-mission-51f41c42',
      'pro-day-mission-c2385776',
      'pro-day-mission-4906690e',
    ]);
  });

  it('T11 closing the sheet keeps its content — no collapse mid-dismiss, no refetch to reopen', async () => {
    const {findByText, getByTestId, queryByTestId, getByText} = render(<SecureProCalendarScreen />);
    await findByText('September 2026');
    fireEvent.press(getByTestId('pro-day-2026-09-02'));
    const fetchesWhileOpen = mockMissions.mock.calls.length;
    expect(getByText('Wed 02 Sep 2026')).toBeTruthy();

    fireEvent.press(getByTestId('pro-day-sheet-close'));
    expect(queryByTestId('pro-day-sheet')).toBeNull();

    // Reopening the same day must not need the network — the content never left.
    fireEvent.press(getByTestId('pro-day-2026-09-02'));
    expect(getByText('Wed 02 Sep 2026')).toBeTruthy();
    expect(mockMissions.mock.calls.length).toBe(fetchesWhileOpen);
  });

  it('T13 a CANCELLED day never paints but still explains itself', async () => {
    mockMissions.mockResolvedValue({data: {missions: [
      mission('canc-1', 'CANCELLED', ['2026-09-12'], {created_at: '2026-09-01T00:00:00.000Z'}),
    ]}});
    const {findByText, getByLabelText, queryByLabelText, getByTestId, queryByTestId} =
      render(<SecureProCalendarScreen />);
    await findByText('September 2026');

    expect(getByLabelText('12 September')).toBeTruthy();
    expect(queryByLabelText(/^12 September, /)).toBeNull(); // no status word — never painted
    expect(queryByTestId('pro-month-chip-0')).toBeNull();   // and therefore no booked-days chip

    fireEvent.press(getByTestId('pro-day-2026-09-12'));
    expect(within(getByTestId('pro-day-mission-canc-1')).getByText('Cancelled')).toBeTruthy();
  });
});

/** CODE lines only — a prose mention of a banned shape must not count. CRLF-safe. */
function codeLines(rel: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of readFileSync(join('src', 'screens', 'securepro', rel), 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(raw.replace(/(^|\s)\/\/.*$/, '$1'));
  }
  return out;
}

describe('the detail sheet keeps its content through the dismiss animation', () => {
  const CODE = codeLines('SecureProCalendarScreen.tsx');
  const BANNED_CLEAR = /set(Sheet|Detail)\(\s*null\s*\)/;
  const BANNED_VISIBLE = /visible=\{sheet\s*!==\s*null\}/;

  it('no close path clears the sheet CONTENT — the card would empty mid-slide', () => {
    expect(CODE.filter(l => BANNED_CLEAR.test(l)).map(l => l.trim())).toEqual([]);
  });

  it('visibility is a separate flag, and every close site flips only that flag', () => {
    const code = CODE.join('\n');
    expect(code).toMatch(/<Modal\s+visible=\{sheetOpen\}/);
    expect(code).not.toMatch(BANNED_VISIBLE);
    // onRequestClose, backdrop press, the in-sheet release, and Close.
    expect(CODE.filter(l => /setSheetOpen\(\s*false\s*\)/.test(l)).length).toBeGreaterThanOrEqual(4);
  });

  it('the scan is not vacuous — it catches the pre-fix shapes', () => {
    expect(BANNED_CLEAR.test('              onPress={() => setSheet(null)}')).toBe(true);
    expect(BANNED_CLEAR.test('        <Pressable style={s.sheetBackdrop} onPress={() => setDetail(null)}>')).toBe(true);
    expect(BANNED_VISIBLE.test('      <Modal visible={sheet !== null} transparent animationType="slide">')).toBe(true);
  });
});

describe('MISSION_STATUS_TONE — every pill colour is a colour RN can parse', () => {
  const COLOUR = /^(#[0-9A-Fa-f]{6}|rgba?\([^)]*\))$/;

  it('has a tone for every mission status', () => {
    expect(Object.keys(MISSION_STATUS_TONE).sort())
      .toEqual(['CANCELLED', 'COMPLETED', 'DECLINED', 'REQUESTED', 'SCHEDULED']);
  });

  it('never carries hex alpha appended to an rgba token', () => {
    const offenders: string[] = [];
    for (const [status, tone] of Object.entries(MISSION_STATUS_TONE)) {
      for (const [slot, value] of Object.entries(tone)) {
        if (!COLOUR.test(value)) {offenders.push(`${status}.${slot} = ${value}`);}
      }
    }
    expect(offenders).toEqual([]);
    // The pre-fix shape this replaced: `color + '14'` / `color + '4D'`.
    expect(COLOUR.test('rgba(180,188,204,0.45)14')).toBe(false);
    expect(COLOUR.test('#A9C5FF4D')).toBe(false);
  });
});
