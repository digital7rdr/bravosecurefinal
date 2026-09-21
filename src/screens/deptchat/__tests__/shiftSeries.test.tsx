/**
 * B-860 (founder 2026-09-11) — _"if I choose a sequence of 10 days for a shift
 * for a person I cannot exclude a day; it could be a holiday — we should have
 * the ability to exclude any date."_
 *
 * Three halves:
 *  · the GENERATOR, which must be a LOCAL CALENDAR add — the weekly path it
 *    replaces used `k × 7 × 86_400_000` on an instant, which lands an hour
 *    early or late across a DST boundary and drags the geofenced check-in
 *    window with it;
 *  · the SCREEN, where the chips have to be removable and Create has to refuse
 *    an empty series;
 *  · the BODY, which now carries `occurrences` (the kept dates) and must never
 *    carry `repeat_weeks` beside it — the DTO refuses the combination.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import React from 'react';
import {render, fireEvent, waitFor} from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn(), getParent: () => undefined, getState: () => ({routeNames: []})}),
  useRoute: () => ({params: undefined}),
  useFocusEffect: (cb: () => void | (() => void)) => { const R = require('react'); R.useEffect(() => cb(), [cb]); },
}));
jest.mock('@hooks/useKeyboardLayout', () => ({
  useKeyboardLayout: () => ({overlap: 0, safeBottom: 0, bottomPad: () => 0}),
  useKeyboardOverlap: () => 0,
  useRevealOnKeyboard: () => jest.fn(),
}));
jest.mock('@/modules/messenger/ui/AmbientBg', () => ({AmbientBg: 'AmbientBg'}));
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('react-native-geolocation-service', () => ({getCurrentPosition: jest.fn(), requestAuthorization: jest.fn()}));
jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
const AUTH_STATE = {user: {id: 'u1', is_org_manager: true, account_kind: 'agency'}};
jest.mock('@store/authStore', () => {
  const useAuthStore = (sel: (s: unknown) => unknown) => sel(AUTH_STATE);
  useAuthStore.getState = () => AUTH_STATE;
  return {useAuthStore};
});
const mockCreateShift = jest.fn();
jest.mock('@services/api', () => ({
  attendanceApi: {
    createShift: (...a: unknown[]) => mockCreateShift(...a),
    listShiftAssignments: jest.fn().mockResolvedValue({data: {assignments: []}}),
  },
  orgApi: {listCpos: jest.fn().mockResolvedValue({data: [
    {user_id: 'c1', display_name: 'Dana Rivers', status: 'active', member_role: 'employee'},
  ]})},
}));
const mockAlert = jest.fn();
jest.mock('@utils/alert', () => ({Alert: {alert: (...a: unknown[]) => mockAlert(...a)}}));

import {
  DAILY_COUNTS, MAX_OCCURRENCES, WEEKLY_COUNTS, keptDates, localDateKey, seriesBlocker,
  seriesDates, spansTwoMonths, windowsOverlap,
} from '../shiftSeries';
import ShiftEditorScreen from '../ShiftEditorScreen';

describe('B-860 — the generator', () => {
  const anchor = new Date(2026, 8, 11, 6, 0, 0); // Fri 11 Sep 2026, LOCAL

  it('daily × N is N consecutive local days, the anchor included', () => {
    expect(seriesDates(anchor, 'daily', 3)).toEqual(['2026-09-11', '2026-09-12', '2026-09-13']);
  });

  it('weekly × N steps seven local days at a time', () => {
    expect(seriesDates(anchor, 'weekly', 3)).toEqual(['2026-09-11', '2026-09-18', '2026-09-25']);
  });

  it("'none' is the anchor alone — the ordinary single-shift form", () => {
    expect(seriesDates(anchor, 'none', 9)).toEqual(['2026-09-11']);
    expect(seriesDates(anchor, 'daily', 1)).toEqual(['2026-09-11']);
    expect(seriesDates(anchor, 'daily', 0)).toEqual(['2026-09-11']);
  });

  it('rolls month and year ends without arithmetic of its own', () => {
    expect(seriesDates(new Date(2026, 11, 30, 6), 'daily', 4))
      .toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  });

  it('is a LOCAL CALENDAR add — a DST boundary does not shift the day', () => {
    /**
     * THE reason this module exists. `+ k × 86_400_000` on an instant crossing a
     * DST change produces the PREVIOUS or NEXT calendar day depending on the
     * direction, because a local day is 23 or 25 hours long that week. The
     * dates below are whatever the runner's zone makes them — what is pinned is
     * that they are CONSECUTIVE and never repeat or skip.
     */
    for (const start of [new Date(2026, 2, 27, 2, 30), new Date(2026, 9, 23, 2, 30)]) {
      const days = seriesDates(start, 'daily', 8);
      expect(new Set(days).size).toBe(8);
      for (let i = 1; i < days.length; i += 1) {
        const prev = new Date(`${days[i - 1]}T12:00:00Z`).getTime();
        const cur = new Date(`${days[i]}T12:00:00Z`).getTime();
        expect(cur - prev).toBe(86_400_000);
      }
      // …and the FIRST entry is the anchor's own local day, not a UTC one.
      expect(days[0]).toBe(localDateKey(start));
    }
  });

  it('never exceeds the DTO cap, whatever it is asked for', () => {
    expect(seriesDates(anchor, 'daily', 99)).toHaveLength(MAX_OCCURRENCES);
    expect(Math.max(...DAILY_COUNTS)).toBeLessThanOrEqual(MAX_OCCURRENCES);
    expect(Math.max(...WEEKLY_COUNTS)).toBeLessThanOrEqual(12);
  });
});

describe('B-860 — exclusions and the warnings', () => {
  it('keptDates removes the excluded days and keeps the order', () => {
    const all = ['2026-09-11', '2026-09-12', '2026-09-13'];
    expect(keptDates(all, new Set(['2026-09-12']))).toEqual(['2026-09-11', '2026-09-13']);
    expect(keptDates(all, new Set())).toEqual(all);
    expect(keptDates(all, new Set(all))).toEqual([]);
  });

  it('Create is blocked at ZERO and above the cap, and nowhere in between', () => {
    expect(seriesBlocker([])).toBe('empty');
    expect(seriesBlocker(['a'])).toBeNull();
    expect(seriesBlocker(new Array(MAX_OCCURRENCES).fill('d'))).toBeNull();
    expect(seriesBlocker(new Array(MAX_OCCURRENCES + 1).fill('d'))).toBe('too_many');
  });

  it('windowsOverlap ignores TOUCHING edges — a 24-hour daily series is not a conflict', () => {
    const touching = [
      {start_at: '2026-09-11T06:00:00.000Z', end_at: '2026-09-12T06:00:00.000Z'},
      {start_at: '2026-09-12T06:00:00.000Z', end_at: '2026-09-13T06:00:00.000Z'},
    ];
    expect(windowsOverlap(touching)).toBe(false);
    // An overnight 22:00–06:00 daily pair does not overlap either.
    expect(windowsOverlap([
      {start_at: '2026-09-11T22:00:00.000Z', end_at: '2026-09-12T06:00:00.000Z'},
      {start_at: '2026-09-12T22:00:00.000Z', end_at: '2026-09-13T06:00:00.000Z'},
    ])).toBe(false);
    // A genuinely longer-than-a-day window does.
    expect(windowsOverlap([
      {start_at: '2026-09-11T06:00:00.000Z', end_at: '2026-09-13T06:00:00.000Z'},
      {start_at: '2026-09-12T06:00:00.000Z', end_at: '2026-09-13T06:00:00.000Z'},
    ])).toBe(true);
    // Unsorted input is sorted first — the caller must not have to.
    expect(windowsOverlap([
      {start_at: '2026-09-12T06:00:00.000Z', end_at: '2026-09-13T06:00:00.000Z'},
      {start_at: '2026-09-11T06:00:00.000Z', end_at: '2026-09-13T06:00:00.000Z'},
    ])).toBe(true);
  });

  it('spansTwoMonths sees the tail that files into an unplanned month', () => {
    expect(spansTwoMonths(['2026-09-29', '2026-09-30'])).toBe(false);
    expect(spansTwoMonths(['2026-09-30', '2026-10-01'])).toBe(true);
    expect(spansTwoMonths([])).toBe(false);
  });
});

describe('B-860 — the editor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateShift.mockResolvedValue({data: {shift: {}, occurrences: 1}});
  });

  it('offers None · Daily · Weekly, and Daily generates removable chips', async () => {
    const ui = render(<ShiftEditorScreen />);
    expect(await ui.findByTestId('repeat-kind-none')).toBeTruthy();
    expect(ui.getByTestId('repeat-kind-daily')).toBeTruthy();
    expect(ui.getByTestId('repeat-kind-weekly')).toBeTruthy();
    // Off by default: nothing changes for a manager creating one shift.
    expect(ui.queryByTestId('series-date-chips')).toBeNull();

    fireEvent.press(ui.getByTestId('repeat-kind-daily'));
    fireEvent.press(ui.getByTestId(`repeat-count-${DAILY_COUNTS[0]}`));
    await waitFor(() => expect(ui.getByTestId('series-date-chips')).toBeTruthy());
    expect(ui.getByText(`WHEN · ${DAILY_COUNTS[0]} DAYS`)).toBeTruthy();
  });

  it('a chip TOGGLES — tap to exclude the holiday, tap again to restore it', async () => {
    const ui = render(<ShiftEditorScreen />);
    fireEvent.press(await ui.findByTestId('repeat-kind-daily'));
    fireEvent.press(ui.getByTestId(`repeat-count-${DAILY_COUNTS[0]}`));
    const chips = await ui.findByTestId('series-date-chips');
    const first = chips.props.children[0].props.testID as string;

    fireEvent.press(ui.getByTestId(first));
    await waitFor(() => expect(ui.getByText(`WHEN · ${DAILY_COUNTS[0] - 1} DAYS`)).toBeTruthy());
    expect(ui.getByLabelText(/excluded\. Tap to include\./)).toBeTruthy();

    fireEvent.press(ui.getByTestId(first));
    await waitFor(() => expect(ui.getByText(`WHEN · ${DAILY_COUNTS[0]} DAYS`)).toBeTruthy());
  });

  /**
   * P2-10 + mutation gap (b) — the exclusions belong to the DATES that produced
   * them.
   *
   * Changing the mode, the count or the anchor DAY re-generates every date, so
   * carrying the old exclusions forward either drops a day nobody asked to drop
   * (an index collision) or silently keeps a "holiday" that no longer exists.
   */
  it('a COUNT change resets the exclusions', async () => {
    const ui = render(<ShiftEditorScreen />);
    fireEvent.press(await ui.findByTestId('repeat-kind-daily'));
    fireEvent.press(ui.getByTestId(`repeat-count-${DAILY_COUNTS[1]}`));
    const chips = await ui.findByTestId('series-date-chips');
    fireEvent.press(ui.getByTestId(chips.props.children[0].props.testID as string));
    await waitFor(() => expect(ui.getByText(`WHEN · ${DAILY_COUNTS[1] - 1} DAYS`)).toBeTruthy());

    fireEvent.press(ui.getByTestId(`repeat-count-${DAILY_COUNTS[2]}`));
    // Full count, not count-1: the exclusion did not survive.
    await waitFor(() => expect(ui.getByText(`WHEN · ${DAILY_COUNTS[2]} DAYS`)).toBeTruthy());
    expect(ui.queryByLabelText(/excluded\. Tap to include\./)).toBeNull();
  });

  it('a MODE change resets the exclusions', async () => {
    const ui = render(<ShiftEditorScreen />);
    fireEvent.press(await ui.findByTestId('repeat-kind-daily'));
    fireEvent.press(ui.getByTestId(`repeat-count-${DAILY_COUNTS[1]}`));
    const chips = await ui.findByTestId('series-date-chips');
    fireEvent.press(ui.getByTestId(chips.props.children[0].props.testID as string));
    await waitFor(() => expect(ui.getByText(`WHEN · ${DAILY_COUNTS[1] - 1} DAYS`)).toBeTruthy());

    fireEvent.press(ui.getByTestId('repeat-kind-weekly'));
    await waitFor(() => expect(ui.getByText(`WHEN · ${WEEKLY_COUNTS[1]} DAYS`)).toBeTruthy());
  });

  it('moving the START DAY resets the exclusions (P2-10)', async () => {
    /**
     * The anchor moves by ONE DAY, and the excluded chip is the SECOND one —
     * so the excluded date is still INSIDE the regenerated range.
     *
     * Mutation-proved: an anchor moved a whole week made the stale exclusion
     * merely inert (its date fell out of the new range), and the assertion
     * passed with the reset deleted. The damaging case is the overlapping one:
     * without the reset the manager silently loses a day they never asked to
     * drop, on a series they thought they had just re-anchored.
     */
    const ui = render(<ShiftEditorScreen />);
    fireEvent.press(await ui.findByTestId('repeat-kind-daily'));
    fireEvent.press(ui.getByTestId(`repeat-count-${DAILY_COUNTS[1]}`));
    const chips = await ui.findByTestId('series-date-chips');
    const kids = chips.props.children as Array<{props: {testID: string}}>;
    // testID is `series-chip-YYYY-MM-DD`; the second chip is anchor + 1 day.
    const secondDay = kids[1].props.testID.replace('series-chip-', '');
    fireEvent.press(ui.getByTestId(kids[1].props.testID));
    await waitFor(() => expect(ui.getByText(`WHEN · ${DAILY_COUNTS[1] - 1} DAYS`)).toBeTruthy());

    // Open the START date picker and move the anchor onto that very day. The
    // picker is a host stub here; its `change` event is `onPickChange`.
    fireEvent.press(ui.getByTestId('window-date-start'));
    const picker = ui.UNSAFE_getByType('DateTimePicker' as never);
    const [y, m, d] = secondDay.split('-').map(Number);
    fireEvent(picker, 'change', {type: 'set'}, new Date(y, m - 1, d, 9, 0, 0, 0));

    // The new series starts ON the previously-excluded day, and it is included.
    await waitFor(() => expect(ui.getByText(`WHEN · ${DAILY_COUNTS[1]} DAYS`)).toBeTruthy());
    expect(ui.queryByLabelText(/excluded\. Tap to include\./)).toBeNull();
  });

  it('excluding EVERY date blocks Create and says so', async () => {
    const ui = render(<ShiftEditorScreen />);
    fireEvent.press(await ui.findByTestId('repeat-kind-daily'));
    fireEvent.press(ui.getByTestId(`repeat-count-${DAILY_COUNTS[0]}`));
    const chips = await ui.findByTestId('series-date-chips');
    for (const child of chips.props.children as Array<{props: {testID: string}}>) {
      fireEvent.press(ui.getByTestId(child.props.testID));
    }
    await waitFor(() => expect(ui.getByText('Every date is excluded — restore at least one day.')).toBeTruthy());
    expect(mockCreateShift).not.toHaveBeenCalled();
  });

  /**
   * BOTH kinds, deliberately. `repeat_weeks` was the WEEKLY lane's body field,
   * so a regression that re-adds it is `repeatKind === 'weekly' ? … : {}` — and
   * a daily-only case passes straight over it. (Mutation-proved: the daily case
   * alone was green against exactly that change.)
   */
  it.each([
    // Counts ≥ 3, so ONE exclusion still leaves a real series: at 2 the kept
    // set is a single day and the body is legitimately the plain form, which
    // would make the `occurrences` assertion below fail for the right reason
    // and hide the wrong one.
    ['daily', DAILY_COUNTS[0]] as const,
    ['weekly', WEEKLY_COUNTS[1]] as const,
  ])('the %s body carries `occurrences` — the KEPT dates — and never `repeat_weeks`', async (kind, count) => {
    const ui = render(<ShiftEditorScreen />);
    fireEvent.press(await ui.findByTestId(`repeat-kind-${kind}`));
    fireEvent.press(ui.getByTestId(`repeat-count-${count}`));
    const chips = await ui.findByTestId('series-date-chips');
    // Exclude one day, so `occurrences` can only be the KEPT set.
    fireEvent.press(ui.getByTestId(chips.props.children[1].props.testID as string));
    // Assign someone (the create path refuses an unassigned shift).
    fireEvent.press(await ui.findByText('Dana Rivers'));
    fireEvent.press(ui.getByText('Create & Assign Shift'));

    await waitFor(() => expect(mockCreateShift).toHaveBeenCalled());
    const body = mockCreateShift.mock.calls[0][0];
    expect(body.occurrences).toHaveLength(count - 1);
    // The DTO refuses both together; `repeat_weeks` stays on it for OLD clients.
    expect(body).not.toHaveProperty('repeat_weeks');
    // Old-server degrade rule: start/end carry the FIRST kept window.
    expect(body.start_at).toBe(body.occurrences[0].start_at);
    expect(body.end_at).toBe(body.occurrences[0].end_at);
  });

  /**
   * P2-9 / N4 — the Create latch is a REF, not `busy`.
   *
   * `busy` is state: reading it in the handler tests the value from the last
   * COMMITTED render, so a second tap inside the same frame — exactly what
   * happens when the JS thread is lagging, which is when this matters — sees
   * `false` and creates the shift a second time. Real shifts, real assignments,
   * one tap burst.
   */
  it('a tap BURST on Create sends exactly one request', async () => {
    let settle: (v: unknown) => void = () => {};
    mockCreateShift.mockReturnValue(new Promise(r => { settle = r; }));
    const ui = render(<ShiftEditorScreen />);
    fireEvent.press(await ui.findByText('Dana Rivers'));
    const btn = ui.getByText('Create & Assign Shift');
    fireEvent.press(btn);
    fireEvent.press(btn);
    fireEvent.press(btn);
    await waitFor(() => expect(mockCreateShift).toHaveBeenCalledTimes(1));
    settle({data: {shift: {}, occurrences: 1}});
  });

  /**
   * …and the SOURCE shape, because the render test above CANNOT tell the two
   * guards apart: `fireEvent.press` wraps each press in `act()`, which flushes
   * the `setBusy(true)` commit before the next one — so a `busy` state check
   * passes here and fails on a device, where the burst lands inside one frame.
   * Mutation-proved: swapping the ref back for `busy` left the burst test green.
   *
   * This is the same shape `rapidUseSourceGuards` pins for the other
   * mutation/money buttons (`processingRef`, the secureProStore mutators).
   */
  it('N4 — the Create guard is a synchronous REF, re-armed in `finally`', () => {
    const src = readFileSync(join(process.cwd(), 'src/screens/deptchat/ShiftEditorScreen.tsx'), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(src).toMatch(/const onSave = async \(\) => \{[\s\S]{0,600}?if \(savingRef\.current\) \{return;\}/);
    expect(src).toMatch(/savingRef\.current = true;\n\s*setBusy\(true\);/);
    expect(src).toMatch(/finally \{[\s\S]{0,200}?savingRef\.current = false;/);
    // A `disabled={busy}` alone is the defect this rule exists for.
    expect(src).not.toMatch(/const onSave = async \(\) => \{\n\s*if \(busy\) \{return;\}/);
  });

  it('exactly ONE kept date sends the plain single-shift body', async () => {
    const ui = render(<ShiftEditorScreen />);
    fireEvent.press(await ui.findByTestId('repeat-kind-daily'));
    fireEvent.press(ui.getByTestId(`repeat-count-${DAILY_COUNTS[0]}`));
    const chips = await ui.findByTestId('series-date-chips');
    const kids = chips.props.children as Array<{props: {testID: string}}>;
    for (const child of kids.slice(1)) {fireEvent.press(ui.getByTestId(child.props.testID));}
    fireEvent.press(await ui.findByText('Dana Rivers'));
    fireEvent.press(ui.getByText('Create & Assign Shift'));

    await waitFor(() => expect(mockCreateShift).toHaveBeenCalled());
    expect(mockCreateShift.mock.calls[0][0]).not.toHaveProperty('occurrences');
    expect(mockCreateShift.mock.calls[0][0]).not.toHaveProperty('repeat_weeks');
  });
});
