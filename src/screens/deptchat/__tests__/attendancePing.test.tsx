/**
 * B-859 (founder 2026-09-11) — _"if I give a shift to a user for any day, there
 * should be an option to ping each user; if an admin or higher pings a person
 * they should see their location while on shift. Other than shift, if pinged,
 * don't share location."_
 *
 * Three halves, pinned here:
 *
 *  · the MANAGER's five states, which are five different facts and must never
 *    collapse into "failed";
 *  · the LAST FIX, which survives a newer request — asking again must not erase
 *    the answer to the last question;
 *  · the WORKER's responder, whose one hard rule is that it NEVER decides
 *    whether the worker is on shift. The server does, twice.
 */
import React from 'react';
import {PermissionsAndroid, Platform, ToastAndroid} from 'react-native';
import {render, fireEvent, waitFor} from '@testing-library/react-native';
import type {ShiftAssigneeDto, ShiftAssigneePingDto, ShiftDto} from '@services/api';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({navigate: mockNavigate, goBack: jest.fn(), getParent: () => undefined, getState: () => ({routeNames: []})}),
  useRoute: () => ({params: undefined}),
  useFocusEffect: (cb: () => void | (() => void)) => { const R = require('react'); R.useEffect(() => cb(), [cb]); },
}));
jest.mock('@hooks/useKeyboardLayout', () => ({
  useKeyboardLayout: () => ({overlap: 0, safeBottom: 0, bottomPad: () => 0}),
  useKeyboardOverlap: () => 0,
  useRevealOnKeyboard: () => jest.fn(),
}));
jest.mock('@/modules/messenger/ui/AmbientBg', () => ({AmbientBg: 'AmbientBg'}));
jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
const AUTH_STATE = {user: {id: 'u1', is_org_manager: true, account_kind: 'agency'}};
jest.mock('@store/authStore', () => {
  const useAuthStore = (sel: (s: unknown) => unknown) => sel(AUTH_STATE);
  useAuthStore.getState = () => AUTH_STATE;
  return {useAuthStore};
});
jest.mock('../placeName', () => ({
  ...jest.requireActual('../placeName'),
  resolvePlaceName: jest.fn().mockResolvedValue(null),
}));

const mockGetCurrentPosition = jest.fn();
jest.mock('react-native-geolocation-service', () => ({
  __esModule: true,
  default: {getCurrentPosition: (...a: unknown[]) => mockGetCurrentPosition(...a)},
  getCurrentPosition: (...a: unknown[]) => mockGetCurrentPosition(...a),
}));

const mockListAssignments = jest.fn();
const mockPingAssignee = jest.fn();
const mockAnswerPing = jest.fn();
const mockRefusePing = jest.fn();
jest.mock('@services/api', () => ({
  attendanceApi: {
    listShiftAssignments: (...a: unknown[]) => mockListAssignments(...a),
    pingAssignee: (...a: unknown[]) => mockPingAssignee(...a),
    answerPing: (...a: unknown[]) => mockAnswerPing(...a),
    refusePing: (...a: unknown[]) => mockRefusePing(...a),
    sessionPhoto: jest.fn().mockResolvedValue({data: {mime: 'image/jpeg', captured_at: null, data_url: 'data:,'}}),
  },
}));

import {ShiftDetailSheet} from '../ShiftDetailSheet';
import {lastFixLine, pingIsLive, pingLine, PING_EXPIRY_MS} from '../AssigneeRow';
import {announceCopy, respondToAttendancePing, __resetPingResponderForTests} from '@services/attendancePingResponder';

const SHIFT: ShiftDto = {
  id: 'sh1', org_user_id: 'o1', department: 'Ops', site_label: 'Gate B',
  site_lat: 25.2, site_lng: 55.27, approved_radius_m: 150,
  start_at: '2026-09-11T06:00:00.000Z', end_at: '2026-09-11T14:00:00.000Z',
  created_by: 'm1', archived_at: null, created_at: '2026-09-01T00:00:00.000Z',
};

const ROW: ShiftAssigneeDto = {
  cpo_user_id: 'c1', display_name: 'Dana Rivers', avatar_url: null,
  call_sign: 'BR-12', department: 'Ops', member_status: 'active',
  session: {
    status: 'open', id: 'ses1', clock_in_at: '2026-09-11T06:04:00.000Z',
    clock_in_lat: 25.2005, clock_in_lng: 55.2701, clock_in_place: 'Gate B',
    clock_out_at: null, within_radius: true, distance_m: 120, has_photo: false,
  },
  last_ping: null,
  last_fix: null,
};

const NOW = Date.parse('2026-09-11T08:00:00.000Z');

beforeEach(() => {
  jest.clearAllMocks();
  __resetPingResponderForTests();
  mockListAssignments.mockResolvedValue({data: {assignments: [ROW]}});
});

describe('B-859 — the manager reads five different facts, never "failed"', () => {
  const base = {id: 'p1', requested_at: '2026-09-11T07:58:00.000Z', answered_at: null,
    lat: null, lng: null, accuracy_m: null} as ShiftAssigneePingDto;
  const site = {lat: 25.2, lng: 55.27};

  it('pending inside the window is "waiting", past it is "No answer" — no server round-trip needed', () => {
    expect(pingLine({...base, status: 'pending'}, site, NOW)).toBe('Pinged · waiting…');
    const stale = {...base, status: 'pending' as const, requested_at: new Date(NOW - PING_EXPIRY_MS - 1).toISOString()};
    expect(pingLine(stale, site, NOW)).toBe('No answer');
    expect(pingIsLive(stale, NOW)).toBe(false);
    expect(pingIsLive({...base, status: 'pending'}, NOW)).toBe(true);
  });

  it('answered says WHEN and how far from site — the manager\'s actual question', () => {
    const line = pingLine({
      ...base, status: 'answered', answered_at: '2026-09-11T07:58:30.000Z',
      lat: 25.2011, lng: 55.2708,
    }, site, NOW);
    expect(line).toMatch(/^Answered /);
    expect(line).toMatch(/from site$/);
  });

  it('answered with NO site still reads — a shift can have no geofence', () => {
    const line = pingLine({...base, status: 'answered', answered_at: base.requested_at, lat: 25.2, lng: 55.27},
      {lat: null, lng: null}, NOW);
    expect(line).toMatch(/^Answered /);
    expect(line).not.toMatch(/from site/);
  });

  it('refused names the REASON — "Declined" alone tells the manager nothing to act on', () => {
    // P1-2 — `off_shift` is the SERVER's verdict at answer time (the worker
    // clocked out between the ask and the answer), and it is the one reason a
    // manager must not read as "they refused me".
    expect(pingLine({...base, status: 'refused', refuse_reason: 'off_shift'}, site, NOW))
      .toBe('Declined · They were no longer clocked in');
    expect(pingLine({...base, status: 'refused', refuse_reason: 'no_permission'}, site, NOW))
      .toBe('Declined · Location permission is off on their phone');
    expect(pingLine({...base, status: 'refused', refuse_reason: 'no_fix'}, site, NOW))
      .toBe('Declined · Their phone could not get a location');
    expect(pingLine({...base, status: 'refused', refuse_reason: 'declined'}, site, NOW))
      .toBe('Declined · They declined');
    // An unknown reason from a newer server degrades, never renders "undefined".
    expect(pingLine({...base, status: 'refused', refuse_reason: 'something_new'}, site, NOW)).toBe('Declined');
    expect(pingLine({...base, status: 'refused'}, site, NOW)).toBe('Declined');
  });

  it('expired is "No answer", and no ping at all is no line', () => {
    expect(pingLine({...base, status: 'expired'}, site, NOW)).toBe('No answer');
    expect(pingLine(null, site, NOW)).toBeNull();
  });
});

describe('B-859 P1-3 — a newer request never erases a known location', () => {
  const FIX = {ping_id: 'p0', lat: 25.2011, lng: 55.2708, accuracy_m: 12, answered_at: '2026-09-11T07:30:00.000Z'};

  it('lastFixLine states the time, the coordinate and the accuracy', () => {
    expect(lastFixLine(FIX)).toMatch(/^Last fix /);
    expect(lastFixLine(FIX)).toContain('±12 m');
    expect(lastFixLine({...FIX, accuracy_m: null})).not.toContain('±');
  });

  it('the row shows the older fix WHILE a newer ping is pending', async () => {
    mockListAssignments.mockResolvedValue({data: {assignments: [{
      ...ROW,
      last_fix: FIX,
      last_ping: {id: 'p1', status: 'pending', requested_at: new Date().toISOString(),
        answered_at: null, lat: null, lng: null, accuracy_m: null},
    }]}});
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    // Waiting for the NEW request…
    expect(await ui.findByText('Pinged · waiting…')).toBeTruthy();
    // …and still showing the OLD answer.
    expect(ui.getByTestId('assignee-last-fix-c1')).toBeTruthy();
    expect(ui.getByTestId('assignee-ping-map-c1')).toBeTruthy();
  });

  it('…and while the newer one is refused or expired', async () => {
    for (const status of ['refused', 'expired'] as const) {
      mockListAssignments.mockResolvedValue({data: {assignments: [{
        ...ROW,
        last_fix: FIX,
        last_ping: {id: 'p1', status, requested_at: '2026-09-11T07:50:00.000Z',
          answered_at: null, lat: null, lng: null, accuracy_m: null},
      }]}});
      const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
      expect(await ui.findByTestId('assignee-last-fix-c1')).toBeTruthy();
      ui.unmount();
    }
  });
});

describe('B-859 — the Ping button', () => {
  it('sends the request and adopts the answer without waiting for a poll', async () => {
    mockPingAssignee.mockResolvedValue({data: {ping: {
      id: 'p1', status: 'pending', requested_at: new Date().toISOString(),
      answered_at: null, lat: null, lng: null, accuracy_m: null,
    }}});
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    fireEvent.press(await ui.findByTestId('assignee-ping-c1'));
    await waitFor(() => expect(mockPingAssignee).toHaveBeenCalledWith('sh1', 'c1'));
    expect(await ui.findByText('Pinged · waiting…')).toBeTruthy();
  });

  it('N4 — a tap BURST sends exactly one request (a synchronous ref, not `disabled`)', async () => {
    let settle: (v: unknown) => void = () => {};
    mockPingAssignee.mockReturnValue(new Promise(r => { settle = r; }));
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    const btn = await ui.findByTestId('assignee-ping-c1');
    fireEvent.press(btn);
    fireEvent.press(btn);
    fireEvent.press(btn);
    expect(mockPingAssignee).toHaveBeenCalledTimes(1);
    settle({data: {ping: {id: 'p1', status: 'pending', requested_at: new Date().toISOString(),
      answered_at: null, lat: null, lng: null, accuracy_m: null}}});
  });

  /**
   * D2 (B-859 E2) — the REAL body, not an invented one.
   *
   * `attendance.controller` throws Nest's `ConflictException('not_on_shift')`
   * and there is no global exception filter, so the wire is
   * `{message: 'not_on_shift', error: 'Conflict', statusCode: 409}` — the code
   * is in `message`, and `error` holds the HTTP REASON PHRASE. Reading `error`
   * first compared "Conflict" against every pattern and fell through to the
   * generic "Could not send the request. Try again.", which is what the device
   * showed. The old fixture here put the code in `error`, so the pin vouched
   * for a payload the server never sends.
   */
  it('translates the real Nest 409 body — the code is in `message`', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{message: 'not_on_shift', error: 'Conflict', statusCode: 409}, 'Not clocked in'],
      [{message: 'ping_pending', error: 'Conflict', statusCode: 409}, 'Pinged · waiting…'],
      [{message: 'ping_rate_limited', error: 'Conflict', statusCode: 409},
        'Asked too recently — try again shortly'],
    ];
    for (const [body, line] of cases) {
      mockPingAssignee.mockRejectedValue({response: {status: 409, data: body}});
      const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
      fireEvent.press(await ui.findByTestId('assignee-ping-c1'));
      expect(await ui.findByText(line)).toBeTruthy();
      ui.unmount();
    }
  });

  it('…and still reads a body that carries the code in `error` only', async () => {
    // A future global exception filter, or any server answering {error: <code>}.
    mockPingAssignee.mockRejectedValue({response: {status: 409, data: {error: 'not_on_shift'}}});
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    fireEvent.press(await ui.findByTestId('assignee-ping-c1'));
    expect(await ui.findByText('Not clocked in')).toBeTruthy();
  });

  it('A9 — hidden on an OLD server (no `session` field), shown on a new one', async () => {
    mockListAssignments.mockResolvedValue({data: {assignments: [
      {cpo_user_id: 'c9', display_name: 'Legacy Person'} as ShiftAssigneeDto,
    ]}});
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    await ui.findByText('Legacy Person');
    expect(ui.queryByTestId('assignee-ping-c9')).toBeNull();
  });

  it('hidden for a member who is no longer in the workspace', async () => {
    mockListAssignments.mockResolvedValue({data: {assignments: [{...ROW, member_status: 'suspended'}]}});
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    await ui.findByText('Dana Rivers');
    expect(ui.queryByTestId('assignee-ping-c1')).toBeNull();
  });

  it('a MISSING member_status is "unknown", never "removed" — the button stays', async () => {
    mockListAssignments.mockResolvedValue({data: {assignments: [{...ROW, member_status: undefined}]}});
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    expect(await ui.findByTestId('assignee-ping-c1')).toBeTruthy();
  });
});

describe('B-859 — the worker\'s own trace (Location requests)', () => {
  const {myPingOutcome, fmtPingWhen} = require('../MyAttendanceScreen') as {
    myPingOutcome: (p: {status: string; refuse_reason: string | null}) => string;
    fmtPingWhen: (iso: string) => string;
  };

  it('says what the PHONE did, with the reason — not a bare "Declined"', () => {
    // `org_audit_log` is manager-readable only, so this list is the only place a
    // worker can see a capture that happened to them. A reason they cannot act
    // on ("Declined") makes the list decorative.
    expect(myPingOutcome({status: 'answered', refuse_reason: null})).toBe('Your location was shared');
    expect(myPingOutcome({status: 'pending', refuse_reason: null})).toMatch(/Waiting/);
    expect(myPingOutcome({status: 'expired', refuse_reason: null})).toBe('Not answered');
    expect(myPingOutcome({status: 'refused', refuse_reason: 'no_permission'}))
      .toBe('Not shared — location permission is off');
    expect(myPingOutcome({status: 'refused', refuse_reason: 'no_fix'}))
      .toBe('Not shared — no location available');
    expect(myPingOutcome({status: 'refused', refuse_reason: 'off_shift'}))
      .toBe('Not shared — you were not clocked in');
    expect(myPingOutcome({status: 'refused', refuse_reason: null})).toBe('Not shared');
  });

  it('the requester line survives a deleted manager account', () => {
    // `requested_by_name` is a LEFT JOIN on public.users — null when the
    // manager's account is gone. The row must still read as a sentence.
    const src = require('fs').readFileSync(
      require('path').join(process.cwd(), 'src/screens/deptchat/MyAttendanceScreen.tsx'), 'utf8');
    expect(src).toContain("{p.requested_by_name ?? 'A manager'}");
  });

  it('prints a DATE and a time — "which shift was that" needs both', () => {
    const out = fmtPingWhen('2026-09-11T14:12:00.000Z');
    expect(out).toMatch(/,/);
    expect(out.length).toBeGreaterThan(6);
    expect(fmtPingWhen('not-a-date')).toBe('');
  });

  /**
   * D3 — and prints the date ONCE.
   *
   * The device showed "Sat, Sep 12, Sep 12, 2:16 AM": a weekday+date prefix
   * AND a second date inside `fmtTime`, which is a date-AND-time formatter.
   * Asserted on the MONTH token rather than a literal string, because the
   * production call passes `undefined` for the locale on purpose — a literal
   * would pin this suite to whatever locale the runner happens to have.
   */
  it('the date appears once, and the two halves are separated by the dot', () => {
    const iso = '2026-09-12T02:16:00.000Z';
    const out = fmtPingWhen(iso);
    const month = new Date(iso).toLocaleDateString(undefined, {month: 'short'});
    expect(out.split(month).length - 1).toBe(1);
    const parts = out.split(' · ');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain(month);
    // …and the time half carries no date at all.
    expect(parts[1]).not.toContain(month);
    expect(parts[1]).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe('B-859 — the worker\'s responder', () => {
  // Spies, not a module mock: react-native comes from the RN jest preset here,
  // so `jest.requireMock('react-native')` returns a module with no
  // PermissionsAndroid on it at all. Same shape `silentLocationFix`'s own suite
  // uses, `restoreAllMocks` included — `restoreMocks` is not set project-wide,
  // so spies would otherwise leak and make this suite order-dependent.
  beforeEach(() => { Platform.OS = 'android'; });
  afterEach(() => { jest.restoreAllMocks(); });
  const permissionsMock = {
    PermissionsAndroid: {get check() { return jest.spyOn(PermissionsAndroid, 'check'); }},
  };

  it('NEVER decides on-shift locally — it takes a fix and answers; the server is the gate', async () => {
    const src = require('fs').readFileSync(
      require('path').join(process.cwd(), 'src/services/attendancePingResponder.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    // A worker can be on two shifts in two organisations at once; a local check
    // would consult whichever store happened to be warm.
    expect(src).not.toContain('myTodayShift');
    expect(src).not.toContain('myShifts');
    expect(src).not.toContain('useAttendance');
  });

  it('answers with one fix, using silentLocationFix\'s options VERBATIM', async () => {
    permissionsMock.PermissionsAndroid.check.mockResolvedValue(true);
    mockGetCurrentPosition.mockImplementation((ok: (p: unknown) => void) =>
      ok({coords: {latitude: 25.2, longitude: 55.27, accuracy: 11.6}}));
    mockAnswerPing.mockResolvedValue({data: {ping: {id: 'p1', status: 'answered'}}});

    expect(await respondToAttendancePing('p1', {announce: false})).toBe('answered');
    expect(mockAnswerPing).toHaveBeenCalledWith('p1', {lat: 25.2, lng: 55.27, accuracy_m: 12});
    const opts = mockGetCurrentPosition.mock.calls[0][2];
    // `showLocationDialog` DEFAULTS TO TRUE and puts a Google Play system modal
    // over whatever the worker is doing; `forceRequestLocation` is the other
    // half that keeps this silent AND useful. Both are load-bearing.
    expect(opts).toMatchObject({
      enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000,
      showLocationDialog: false, forceRequestLocation: true,
    });
  });

  it('a denied permission is REPORTED, not silence', async () => {
    permissionsMock.PermissionsAndroid.check.mockResolvedValue(false);
    mockRefusePing.mockResolvedValue({data: {ping: {id: 'p2', status: 'refused'}}});
    expect(await respondToAttendancePing('p2')).toBe('refused');
    expect(mockRefusePing).toHaveBeenCalledWith('p2', 'no_permission');
    // …and it never asks for the fix it knows it cannot have.
    expect(mockGetCurrentPosition).not.toHaveBeenCalled();
  });

  it('no fix is REPORTED too — "waiting…" for ten minutes hides a dead GPS', async () => {
    permissionsMock.PermissionsAndroid.check.mockResolvedValue(true);
    mockGetCurrentPosition.mockImplementation((_ok: unknown, fail: () => void) => fail());
    mockRefusePing.mockResolvedValue({data: {ping: {id: 'p3', status: 'refused'}}});
    expect(await respondToAttendancePing('p3')).toBe('refused');
    expect(mockRefusePing).toHaveBeenCalledWith('p3', 'no_fix');
  });

  it('the SERVER can still refuse an answered fix (clocked out mid-flight)', async () => {
    permissionsMock.PermissionsAndroid.check.mockResolvedValue(true);
    mockGetCurrentPosition.mockImplementation((ok: (p: unknown) => void) =>
      ok({coords: {latitude: 1, longitude: 2, accuracy: 5}}));
    mockAnswerPing.mockResolvedValue({data: {ping: {id: 'p4', status: 'refused'}}});
    expect(await respondToAttendancePing('p4', {announce: false})).toBe('refused');
  });

  it('one ping is answered ONCE — the wake and the card tap are the same question', async () => {
    permissionsMock.PermissionsAndroid.check.mockResolvedValue(true);
    mockGetCurrentPosition.mockImplementation((ok: (p: unknown) => void) =>
      ok({coords: {latitude: 1, longitude: 2, accuracy: 5}}));
    mockAnswerPing.mockResolvedValue({data: {ping: {id: 'p5', status: 'answered'}}});
    expect(await respondToAttendancePing('p5', {announce: false})).toBe('answered');
    // …and the SECOND delivery is a DUPLICATE, not a failure. The wake reads
    // 'failed' as "not handled" and draws a card for it, so returning 'failed'
    // here told a worker to share a location they had already shared, for a
    // request that no longer accepts one.
    expect(await respondToAttendancePing('p5', {announce: false})).toBe('duplicate');
    expect(mockAnswerPing).toHaveBeenCalledTimes(1);
  });

  it('a REFUSED ping is terminal too — a second delivery is a duplicate', async () => {
    permissionsMock.PermissionsAndroid.check.mockResolvedValue(false);
    mockRefusePing.mockResolvedValue({data: {ping: {id: 'p6', status: 'refused'}}});
    expect(await respondToAttendancePing('p6', {announce: false})).toBe('refused');
    expect(await respondToAttendancePing('p6', {announce: false})).toBe('duplicate');
    expect(mockRefusePing).toHaveBeenCalledTimes(1);
  });

  /**
   * P1-1 — THE CARD LANE. A network failure must leave the id ANSWERABLE.
   *
   * The first cut marked an id handled BEFORE the POST and never released it,
   * so the sequence below produced a card saying "Tap to share your location"
   * whose tap was a dead no-op — the only recovery path this feature has,
   * silently gone.
   */
  it('a failed answer RELEASES the ping, so the card it draws has a live tap', async () => {
    permissionsMock.PermissionsAndroid.check.mockResolvedValue(true);
    mockGetCurrentPosition.mockImplementation((ok: (p: unknown) => void) =>
      ok({coords: {latitude: 1, longitude: 2, accuracy: 5}}));

    mockAnswerPing.mockRejectedValueOnce(new Error('offline'));
    expect(await respondToAttendancePing('p7', {announce: false})).toBe('failed');

    // The tap on the card the wake then drew — it answers, it is not a duplicate.
    mockAnswerPing.mockResolvedValue({data: {ping: {id: 'p7', status: 'answered'}}});
    expect(await respondToAttendancePing('p7', {announce: false})).toBe('answered');
    expect(mockAnswerPing).toHaveBeenCalledTimes(2);
  });

  it('a failed REFUSAL releases it the same way', async () => {
    permissionsMock.PermissionsAndroid.check.mockResolvedValue(false);
    mockRefusePing.mockRejectedValueOnce(new Error('offline'));
    expect(await respondToAttendancePing('p8', {announce: false})).toBe('failed');
    mockRefusePing.mockResolvedValue({data: {ping: {id: 'p8', status: 'refused'}}});
    expect(await respondToAttendancePing('p8', {announce: false})).toBe('refused');
    expect(mockRefusePing).toHaveBeenCalledTimes(2);
  });

  it('two deliveries in the SAME tick still take one fix (the in-flight guard)', async () => {
    permissionsMock.PermissionsAndroid.check.mockResolvedValue(true);
    mockGetCurrentPosition.mockImplementation((ok: (p: unknown) => void) =>
      ok({coords: {latitude: 1, longitude: 2, accuracy: 5}}));
    mockAnswerPing.mockResolvedValue({data: {ping: {id: 'p9', status: 'answered'}}});
    const [a, b] = await Promise.all([
      respondToAttendancePing('p9', {announce: false}),
      respondToAttendancePing('p9', {announce: false}),
    ]);
    expect([a, b].filter(o => o === 'answered')).toHaveLength(1);
    expect([a, b].filter(o => o === 'duplicate')).toHaveLength(1);
    expect(mockGetCurrentPosition).toHaveBeenCalledTimes(1);
  });
});

describe('B-859 P2-1 — a failed POLL never wipes good rows', () => {
  const PENDING: ShiftAssigneeDto = {
    ...ROW,
    last_ping: {id: 'p1', status: 'pending', requested_at: new Date().toISOString(),
      answered_at: null, lat: null, lng: null, accuracy_m: null},
  };

  it('keeps the roster when the 15 s refresh fails, and never shows an error card', async () => {
    jest.useFakeTimers();
    try {
      mockListAssignments.mockResolvedValueOnce({data: {assignments: [PENDING]}});
      const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
      await waitFor(() => expect(ui.getByText('Dana Rivers')).toBeTruthy());

      // A tunnel, a dropped Wi-Fi hop. The manager is mid-shift, reading this.
      mockListAssignments.mockRejectedValue(new Error('offline'));
      await require('react-test-renderer').act(async () => {
        jest.advanceTimersByTime(15_000);
        await Promise.resolve();
      });

      expect(ui.getByText('Dana Rivers')).toBeTruthy();
      expect(ui.queryByText('Could not load')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('the INITIAL load still owns the error state', async () => {
    mockListAssignments.mockRejectedValue(new Error('offline'));
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    expect(await ui.findByText('Could not load')).toBeTruthy();
  });
});

describe('B-859 P2-2 — a stale 409 message does not outlive its request', () => {
  const {PingControl} = require('../AssigneeRow') as typeof import('../AssigneeRow');

  it('clears the local error when a NEW ping arrives on the row', async () => {
    mockPingAssignee.mockRejectedValue(
      {response: {status: 409, data: {message: 'not_on_shift', error: 'Conflict', statusCode: 409}}});
    const props = {
      shiftId: 'sh1', site: {lat: 25.2, lng: 55.27},
      onPinged: jest.fn(), onOpenPingMap: jest.fn(),
    };
    const ui = render(<PingControl a={ROW} {...props} />);
    fireEvent.press(ui.getByTestId('assignee-ping-c1'));
    expect(await ui.findByText('Not clocked in')).toBeTruthy();

    /**
     * The worker clocks in and a later request is ANSWERED; the poll brings it.
     * `error` out-ranks the server's own line in the render, so without the
     * reset the row keeps reading "Not clocked in" over the top of a fix that
     * arrived — until the sheet is closed and re-opened.
     *
     * The new ping must NOT be `pending`: a live request hides the line
     * entirely, so a pending rerender passes whether or not the error cleared
     * (mutation-proved — the first version of this case did exactly that).
     */
    ui.rerender(<PingControl a={{...ROW, last_ping: {
      id: 'p-new', status: 'answered', requested_at: new Date().toISOString(),
      answered_at: new Date().toISOString(), lat: 25.2, lng: 55.27, accuracy_m: 9,
    }}} {...props} />);
    await waitFor(() => expect(ui.queryByText('Not clocked in')).toBeNull());
    expect(ui.getByText(/^Answered /)).toBeTruthy();
  });
});

describe('B-859 P2-8 — a broken avatar falls back instead of opening a black screen', () => {
  const WITH_PHOTO = {...ROW, avatar_url: 'https://example.invalid/a.jpg'};

  it('renders the image and opens the viewer on tap', async () => {
    mockListAssignments.mockResolvedValue({data: {assignments: [WITH_PHOTO]}});
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    expect(await ui.findByTestId('assignee-avatar-img-c1')).toBeTruthy();
    fireEvent.press(ui.getByTestId('assignee-avatar-c1'));
    expect(await ui.findByTestId('avatar-viewer-image')).toBeTruthy();
  });

  it('a 403/404 on the row falls back to initials AND stops being tappable', async () => {
    mockListAssignments.mockResolvedValue({data: {assignments: [WITH_PHOTO]}});
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    const img = await ui.findByTestId('assignee-avatar-img-c1');
    fireEvent(img, 'error');
    await waitFor(() => expect(ui.queryByTestId('assignee-avatar-img-c1')).toBeNull());
    expect(ui.getByText('DR')).toBeTruthy();
    // A viewer opened on an initials fallback is a full-screen black rectangle.
    fireEvent.press(ui.getByTestId('assignee-avatar-c1'));
    expect(ui.queryByTestId('avatar-viewer-image')).toBeNull();
  });

  it('the VIEWER shows the fallback with a Retry when its image fails', async () => {
    mockListAssignments.mockResolvedValue({data: {assignments: [WITH_PHOTO]}});
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    fireEvent.press(await ui.findByTestId('assignee-avatar-c1'));
    const viewerImg = await ui.findByTestId('avatar-viewer-image');
    // First attempt requests the URL VERBATIM — a signed URL whose signature
    // covers the query string breaks the moment a parameter is appended.
    expect(viewerImg.props.source.uri).toBe('https://example.invalid/a.jpg');

    fireEvent(viewerImg, 'error');
    expect(await ui.findByTestId('avatar-viewer-fallback')).toBeTruthy();
    expect(ui.getByText('This photo could not be loaded.')).toBeTruthy();

    fireEvent.press(ui.getByTestId('avatar-viewer-retry'));
    const retried = await ui.findByTestId('avatar-viewer-image');
    // …and the retry DOES bust the cache, or RN serves the failure again.
    expect(retried.props.source.uri).toMatch(/_r=1$/);
  });
});

describe('B-859 P1-2 — every outcome is announced, not only the happy one', () => {
  /**
   * The killed lane's card says "Tap to share your location", and notifee's
   * `autoCancel` removes it on the tap. So a tap whose share then FAILED left
   * nothing on screen at all and a worker believing they had shared something
   * they had not. Each outcome gets a sentence, and the two the worker can act
   * on say where to look.
   */
  it('names the outcome, with the reason for a refusal', () => {
    expect(announceCopy('answered')).toMatch(/shared\.$/);
    expect(announceCopy('refused', 'no_permission')).toMatch(/location permission is off/);
    expect(announceCopy('refused', 'no_fix')).toMatch(/no location available/);
    expect(announceCopy('refused', 'off_shift')).toMatch(/not clocked in/);
    expect(announceCopy('refused')).toBe('Your manager asked for your location — not shared.');
    // The failure copy points at the durable list, which is the only place left
    // to see the request once the card is gone.
    expect(announceCopy('failed')).toMatch(/Location requests/);
    // A duplicate is not news — the first delivery already said its piece.
    expect(announceCopy('duplicate')).toBeNull();
  });

  it('the toast actually fires on a refusal and on a failure', async () => {
    const toast = jest.spyOn(ToastAndroid, 'show').mockImplementation(() => {});
    Platform.OS = 'android';
    const perm = jest.spyOn(PermissionsAndroid, 'check');

    perm.mockResolvedValue(false);
    mockRefusePing.mockResolvedValue({data: {ping: {id: 'q1', status: 'refused'}}});
    await respondToAttendancePing('q1');
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/location permission is off/), expect.anything());

    // BOTH failure arms. They are separate catch blocks — a fix that only
    // announces on one of them passes a test that only exercises the other.
    toast.mockClear();
    mockRefusePing.mockRejectedValue(new Error('offline'));
    await respondToAttendancePing('q2');
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Location requests/), expect.anything());

    toast.mockClear();
    perm.mockResolvedValue(true);
    mockGetCurrentPosition.mockImplementation((ok: (p: unknown) => void) =>
      ok({coords: {latitude: 1, longitude: 2, accuracy: 5}}));
    mockAnswerPing.mockRejectedValue(new Error('offline'));
    await respondToAttendancePing('q3');
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Location requests/), expect.anything());

    // …and the SERVER's own off-shift verdict is announced, not swallowed.
    toast.mockClear();
    mockAnswerPing.mockResolvedValue({data: {ping: {id: 'q4', status: 'refused'}}});
    await respondToAttendancePing('q4');
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/not clocked in/), expect.anything());

    // An ANSWERED one still says so.
    toast.mockClear();
    mockAnswerPing.mockResolvedValue({data: {ping: {id: 'q5', status: 'answered'}}});
    await respondToAttendancePing('q5');
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/shared\./), expect.anything());

    jest.restoreAllMocks();
  });

  it('the card TAP does not suppress the announcement', () => {
    const boot = require('fs').readFileSync(
      require('path').join(process.cwd(), 'src/modules/messenger/push/fcmBootstrap.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const at = boot.indexOf("} else if (kind === 'attendance-ping') {");
    expect(at).toBeGreaterThan(-1);
    const branch = boot.slice(at, boot.indexOf('} else if (', at + 10));
    expect(branch).toContain('respondToAttendancePing(pingId)');
    // `{announce: false}` is the TEST seam. On the tap lane the app is coming to
    // the foreground and the toast is the only thing the worker will see.
    expect(branch).not.toContain('announce: false');
  });
});

/**
 * B-859 follow-up — a TERMINAL server refusal is not a retryable failure.
 *
 * The answer catch mapped every non-2xx to `'failed'`, which the wake reads as
 * "not handled": it drew a card saying "Tap to share your location" for a
 * request the server had already closed, and the tap took ANOTHER GPS fix — a
 * location capture for a question that no longer accepts one. 403/404/409 are
 * the server's last word, so they latch exactly like an answer.
 */
describe('B-859 P3 — 403 / 404 / 409 are terminal, only 5xx and the network retry', () => {
  beforeEach(() => { Platform.OS = 'android'; });
  afterEach(() => { jest.restoreAllMocks(); });
  const permissionsMock = {
    PermissionsAndroid: {get check() { return jest.spyOn(PermissionsAndroid, 'check'); }},
  };
  const okFix = () => {
    permissionsMock.PermissionsAndroid.check.mockResolvedValue(true);
    mockGetCurrentPosition.mockImplementation((ok: (p: unknown) => void) =>
      ok({coords: {latitude: 1, longitude: 2, accuracy: 5}}));
  };
  /** The axios shape the responder has to read the status off. */
  const http = (status: number, error?: string) =>
    Object.assign(new Error(`http ${status}`), {response: {status, data: error ? {error} : {}}});

  it('409 ping_expired latches — no card, no retry, and no second capture', async () => {
    okFix();
    mockAnswerPing.mockRejectedValue(http(409, 'ping_expired'));
    expect(await respondToAttendancePing('t1', {announce: false})).toBe('duplicate');
    // 'duplicate' is the wake's "nothing left to do" — the copy is silence.
    expect(announceCopy('duplicate')).toBeNull();
    // Latched: a second delivery must not re-acquire GPS for a dead request.
    expect(await respondToAttendancePing('t1', {announce: false})).toBe('duplicate');
    expect(mockAnswerPing).toHaveBeenCalledTimes(1);
    expect(mockGetCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('409 ping_not_pending, 404 and 403 are all terminal', async () => {
    for (const [i, e] of [http(409, 'ping_not_pending'), http(404), http(403, 'not_your_ping')].entries()) {
      okFix();
      mockAnswerPing.mockRejectedValue(e);
      expect(await respondToAttendancePing(`t2-${i}`, {announce: false})).toBe('duplicate');
    }
  });

  it('409/404 say so once; 403 (not ours to answer) says nothing at all', async () => {
    okFix();
    const toast = jest.spyOn(ToastAndroid, 'show').mockImplementation(() => {});
    mockAnswerPing.mockRejectedValue(http(409, 'ping_expired'));
    expect(await respondToAttendancePing('t3')).toBe('duplicate');
    expect(toast).toHaveBeenCalledWith('This location request has expired.', ToastAndroid.LONG);

    toast.mockClear();
    mockAnswerPing.mockRejectedValue(http(403, 'not_your_ping'));
    expect(await respondToAttendancePing('t4')).toBe('duplicate');
    expect(toast).not.toHaveBeenCalled();
  });

  it('a 500 and a bare network error still RELEASE the id — the card tap retries', async () => {
    okFix();
    mockAnswerPing.mockRejectedValueOnce(http(500));
    expect(await respondToAttendancePing('t5', {announce: false})).toBe('failed');
    mockAnswerPing.mockResolvedValue({data: {ping: {id: 't5', status: 'answered'}}});
    expect(await respondToAttendancePing('t5', {announce: false})).toBe('answered');

    mockAnswerPing.mockRejectedValueOnce(new Error('offline'));
    expect(await respondToAttendancePing('t6', {announce: false})).toBe('failed');
  });
});

/**
 * B-859 follow-up — Android's `mocked` flag rides with the fix.
 *
 * `onDutyHeartbeat` has carried `is_mocked` since Step 23 anti-fraud; this lane
 * dropped it, so the ONE place a manager deliberately asks "where are you" was
 * the one place a spoofed position arrived unlabelled.
 */
describe('B-859 — a device-reported mock location is carried and labelled', () => {
  const FIX = {ping_id: 'p0', lat: 25.2011, lng: 55.2708, accuracy_m: 12,
    answered_at: '2026-09-11T07:30:00.000Z'};

  describe('the worker side', () => {
    beforeEach(() => { Platform.OS = 'android'; });
    afterEach(() => { jest.restoreAllMocks(); });
    const permissionsMock = {
      PermissionsAndroid: {get check() { return jest.spyOn(PermissionsAndroid, 'check'); }},
    };

    it('sends mocked:true when the position reports it, and OMITS the key otherwise', async () => {
      permissionsMock.PermissionsAndroid.check.mockResolvedValue(true);
      mockAnswerPing.mockResolvedValue({data: {ping: {id: 'm1', status: 'answered'}}});

      mockGetCurrentPosition.mockImplementation((ok: (p: unknown) => void) =>
        ok({coords: {latitude: 1, longitude: 2, accuracy: 5}, mocked: true}));
      expect(await respondToAttendancePing('m1', {announce: false})).toBe('answered');
      expect(mockAnswerPing).toHaveBeenLastCalledWith('m1', {lat: 1, lng: 2, accuracy_m: 5, mocked: true});

      // iOS has no such flag, and an old server whitelists the body — so the
      // KEY is absent, never present-and-undefined.
      mockGetCurrentPosition.mockImplementation((ok: (p: unknown) => void) =>
        ok({coords: {latitude: 1, longitude: 2, accuracy: 5}}));
      expect(await respondToAttendancePing('m2', {announce: false})).toBe('answered');
      const body = mockAnswerPing.mock.calls[mockAnswerPing.mock.calls.length - 1][1] as object;
      expect(Object.keys(body)).not.toContain('mocked');
    });
  });

  it('lastFixLine names it, and says nothing when the flag is absent or false', () => {
    expect(lastFixLine({...FIX, mocked: true})).toContain('device-reported mock location');
    expect(lastFixLine(FIX)).not.toContain('mock');
    expect(lastFixLine({...FIX, mocked: false})).not.toContain('mock');
  });

  it('the manager sees it on the row', async () => {
    mockListAssignments.mockResolvedValue({data: {assignments: [
      {...ROW, last_fix: {...FIX, mocked: true}},
    ]}});
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    expect(await ui.findByText(/device-reported mock location/)).toBeTruthy();
  });

  it('the last_ping FALLBACK carries it too — the deploy window before last_fix exists', async () => {
    mockListAssignments.mockResolvedValue({data: {assignments: [{
      ...ROW,
      last_fix: null,
      last_ping: {id: 'p1', status: 'answered', requested_at: '2026-09-11T07:30:00.000Z',
        answered_at: '2026-09-11T07:30:10.000Z', lat: 25.2, lng: 55.27, accuracy_m: 9, mocked: true},
    }]}});
    const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
    expect(await ui.findByText(/device-reported mock location/)).toBeTruthy();
  });
});

/**
 * B-859 follow-up — the `not_on_shift` refusal has to be able to CLEAR.
 *
 * It creates no ping row, so `last_ping.id` never changes and the P2-2 reset
 * (keyed on the ping id) can never fire; and the sheet's 15 s poll is gated on
 * a LIVE ping, so nothing ever refetches either. The manager was left reading
 * "Not clocked in" over a worker who had since clocked in, with Ping dead,
 * until the sheet was closed and re-opened.
 */
describe('B-859 P3 — the not_on_shift refusal clears when the worker clocks in', () => {
  const {PingControl} = require('../AssigneeRow') as typeof import('../AssigneeRow');
  const OFF: ShiftAssigneeDto = {
    ...ROW,
    session: {status: 'not_started', id: null, clock_in_at: null, clock_in_lat: null,
      clock_in_lng: null, clock_in_place: null, clock_out_at: null,
      within_radius: null, distance_m: null, has_photo: false},
  };

  it('the error clears on a SESSION change, with no new ping row to key on', async () => {
    mockPingAssignee.mockRejectedValue(
      {response: {status: 409, data: {message: 'not_on_shift', error: 'Conflict', statusCode: 409}}});
    const props = {
      shiftId: 'sh1', site: {lat: 25.2, lng: 55.27},
      onPinged: jest.fn(), onOpenPingMap: jest.fn(),
    };
    const ui = render(<PingControl a={OFF} {...props} />);
    fireEvent.press(ui.getByTestId('assignee-ping-c1'));
    expect(await ui.findByText('Not clocked in')).toBeTruthy();

    // The worker clocks in. `last_ping` is STILL null — the refusal never made
    // a row — so the ping-id reset cannot be what clears this.
    ui.rerender(<PingControl a={{...OFF, session: {...OFF.session!, status: 'open', id: 'ses9'}}} {...props} />);
    await waitFor(() => expect(ui.queryByText('Not clocked in')).toBeNull());
    expect(ui.getByTestId('assignee-ping-c1').props.accessibilityState?.disabled).toBeFalsy();
  });

  it('the SHEET keeps polling after a refusal, so the clock-in arrives on its own', async () => {
    jest.useFakeTimers();
    try {
      mockListAssignments.mockResolvedValue({data: {assignments: [OFF]}});
      mockPingAssignee.mockRejectedValue(
        {response: {status: 409, data: {message: 'not_on_shift', error: 'Conflict', statusCode: 409}}});
      const ui = render(<ShiftDetailSheet open shift={SHIFT} onClose={jest.fn()} />);
      await require('react-test-renderer').act(async () => { await Promise.resolve(); });
      expect(mockListAssignments).toHaveBeenCalledTimes(1);

      fireEvent.press(ui.getByTestId('assignee-ping-c1'));
      await require('react-test-renderer').act(async () => { await Promise.resolve(); });
      expect(ui.getByText('Not clocked in')).toBeTruthy();

      // No LIVE ping exists, so the old gate stopped here and the row stayed
      // wrong forever. The worker clocks in and the poll brings it.
      mockListAssignments.mockResolvedValue({data: {assignments: [
        {...OFF, session: {...OFF.session!, status: 'open', id: 'ses9'}},
      ]}});
      await require('react-test-renderer').act(async () => {
        jest.advanceTimersByTime(15_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockListAssignments.mock.calls.length).toBeGreaterThan(1);
      await waitFor(() => expect(ui.queryByText('Not clocked in')).toBeNull());
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * B-866 — ONE high-accuracy retry before the phone says "no location".
 *
 * Device evidence (1.0.312, three pings to the same clocked-in worker on the
 * same shift): the two answered in 0.8 s / 2.6 s both logged
 * `RNFusedLocation: returning cached location`; the one raised while the worker
 * sat on the map-heavy booking screen had no cached fix to serve and refused
 * `no_fix` after 8.7 s — the single low-accuracy ask timing out. A ping lives
 * ten minutes, so refusing after one cheap attempt spends 0.1% of the budget.
 *
 * What must NOT change: a denied permission is still an immediate
 * `no_permission` with no fix asked for at all; a refusal is still ONE POST;
 * and neither attempt may put anything on screen.
 */
describe('B-866 — the responder retries once before refusing', () => {
  beforeEach(() => { Platform.OS = 'android'; });
  afterEach(() => { jest.restoreAllMocks(); });
  const permissionsMock = {
    PermissionsAndroid: {get check() { return jest.spyOn(PermissionsAndroid, 'check'); }},
  };

  /** nth attempt (1-based) -> resolve with a fix, or fail. */
  function positions(...outcomes: Array<'fix' | 'fail'>): void {
    let n = 0;
    mockGetCurrentPosition.mockImplementation((ok: (p: unknown) => void, fail: () => void) => {
      const outcome = outcomes[n++] ?? 'fail';
      if (outcome === 'fix') {ok({coords: {latitude: 25.2, longitude: 55.27, accuracy: 9}});}
      else {fail();}
    });
  }

  it('a first attempt with no fix is retried at HIGH accuracy, and that fix is ANSWERED', async () => {
    permissionsMock.PermissionsAndroid.check.mockResolvedValue(true);
    positions('fail', 'fix');
    mockAnswerPing.mockResolvedValue({data: {ping: {id: 'r1', status: 'answered'}}});

    expect(await respondToAttendancePing('r1', {announce: false})).toBe('answered');
    expect(mockGetCurrentPosition).toHaveBeenCalledTimes(2);
    expect(mockRefusePing).not.toHaveBeenCalled();
    expect(mockAnswerPing).toHaveBeenCalledWith('r1', {lat: 25.2, lng: 55.27, accuracy_m: 9});

    // The retry is the OTHER kind of ask: the cheap cached lane already came
    // back empty, so asking it again the same way is not a retry at all.
    const first = mockGetCurrentPosition.mock.calls[0][2] as Record<string, unknown>;
    const retry = mockGetCurrentPosition.mock.calls[1][2] as Record<string, unknown>;
    expect(first).toMatchObject({enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000});
    expect(retry.enableHighAccuracy).toBe(true);
    expect(retry.maximumAge).toBe(0);
    expect(retry.timeout as number).toBeGreaterThan(first.timeout as number);
    // …and it stays SILENT. showLocationDialog defaults to TRUE in the package
    // and would throw a Google Play system modal over a worker on duty.
    for (const opts of [first, retry]) {
      expect(opts).toMatchObject({showLocationDialog: false, forceRequestLocation: true});
    }
    // Both attempts together stay far inside the ping's ten-minute life.
    expect((first.timeout as number) + (retry.timeout as number)).toBeLessThan(60_000);
  });

  it('both attempts empty is exactly ONE no_fix refusal — never two POSTs', async () => {
    permissionsMock.PermissionsAndroid.check.mockResolvedValue(true);
    positions('fail', 'fail');
    mockRefusePing.mockResolvedValue({data: {ping: {id: 'r2', status: 'refused'}}});

    expect(await respondToAttendancePing('r2', {announce: false})).toBe('refused');
    expect(mockGetCurrentPosition).toHaveBeenCalledTimes(2);
    expect(mockRefusePing).toHaveBeenCalledTimes(1);
    expect(mockRefusePing).toHaveBeenCalledWith('r2', 'no_fix');
    expect(mockAnswerPing).not.toHaveBeenCalled();
  });

  it('a fix on the FIRST attempt takes no second one — the retry is not a second capture', async () => {
    permissionsMock.PermissionsAndroid.check.mockResolvedValue(true);
    positions('fix');
    mockAnswerPing.mockResolvedValue({data: {ping: {id: 'r3', status: 'answered'}}});

    expect(await respondToAttendancePing('r3', {announce: false})).toBe('answered');
    expect(mockGetCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('a denied permission still refuses IMMEDIATELY — the retry is not a way in', async () => {
    permissionsMock.PermissionsAndroid.check.mockResolvedValue(false);
    positions('fix', 'fix');
    mockRefusePing.mockResolvedValue({data: {ping: {id: 'r4', status: 'refused'}}});

    expect(await respondToAttendancePing('r4', {announce: false})).toBe('refused');
    expect(mockRefusePing).toHaveBeenCalledWith('r4', 'no_permission');
    // NOTHING is asked of the provider, so nothing can prompt.
    expect(mockGetCurrentPosition).not.toHaveBeenCalled();
  });
});
