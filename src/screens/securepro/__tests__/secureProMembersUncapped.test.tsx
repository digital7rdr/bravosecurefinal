/**
 * B-832 / B-833 / B-835 — Bravo Secure Pro linked members are UNLIMITED,
 * neutrally named, and paged.
 *
 * Replaces `secureProMemberSeats.test.tsx` (PDF-1 #7), which pinned the 4-seat
 * cap's "Request additional seats" escape hatch. The cap is gone, so the escape
 * hatch is gone with it: at 4 — and at 40 — the ordinary "Add Member" CTA is
 * what renders, and `familyApi.requestSeats` no longer exists to be called.
 *
 * RED-first against the pre-fix screen: at 4 active members the CTA reads
 * "Request additional seats", a RELATIONSHIP section gates Send Invite, and
 * there is no roster search box at all.
 */
import React from 'react';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {render, fireEvent, waitFor, act} from '@testing-library/react-native';
import SecureProMembersScreen from '@screens/securepro/SecureProMembersScreen';
import {familyApi} from '@services/api';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn(), setParams: jest.fn()}),
  // B-854/P1-2 — the screen reads `focusMemberRowId` off the route to mark the
  // roster row a funding wake named. No params here: these cases reach the
  // roster without one.
  useRoute: () => ({params: undefined}),
  useFocusEffect: (cb: () => void) => {
    const react = require('react');
    react.useEffect(cb, []);
  },
}));

const member = (i: number) => ({
  id: `m${i}`, memberId: `u${i}`, name: `Member ${i}`, avatarUrl: null,
  status: 'active', heldUntil: null,
  spendLimit: null, spent: 0,
  invitedAt: '2026-08-01T00:00:00.000Z', acceptedAt: '2026-08-01T00:00:00.000Z',
  lastLocation: null,
});

const CONTACT = {
  userId: 'u-new', phoneE164: '+971509999999',
  localName: 'Sam Contact', displayName: 'Sam Contact', avatarUrl: null,
};

jest.mock('@services/api', () => ({
  familyApi: {
    members: jest.fn(),
    creditRequests: jest.fn().mockResolvedValue({data: {requests: []}}),
    memberSpend: jest.fn().mockResolvedValue({data: {member: {}, byFeature: [], transactions: []}}),
    invite: jest.fn(),
    setHold: jest.fn(),
    setLimit: jest.fn(),
    remove: jest.fn(),
  },
  tokenStore: {get: jest.fn(), set: jest.fn()},
  refreshAccessTokenShared: jest.fn(),
}));

jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));
jest.mock('@hooks/useProPlanGate', () => ({useProPlanGate: () => {}}));
jest.mock('@hooks/useBottomInset', () => ({
  useBottomInset: () => ({contentBottom: () => 110, bottomPad: () => 12}),
}));
jest.mock('@hooks/useKeyboardLayout', () => ({
  useKeyboardLayout: () => ({overlap: 0, visible: false, safeBottom: 0, bottomPad: (g = 0) => g}),
}));
jest.mock('@/modules/messenger/contacts/useDiscoveredContacts', () => ({
  useDiscoveredContacts: () => ({
    matches: [{
      userId: 'u-new', phoneE164: '+971509999999',
      localName: 'Sam Contact', displayName: 'Sam Contact', avatarUrl: null,
    }],
    loading: false,
    permission: 'granted',
  }),
}));
jest.mock('@bravo/messenger-core', () => ({UsersHttpClient: class {}}));
jest.mock('@/modules/news/mapbox', () => ({buildPinMapUrl: () => ''}));
jest.mock('@store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({user: {phone_e164: '+971500000000'}}),
}));

const mockMembers = familyApi.members as jest.Mock;
const mockInvite = familyApi.invite as jest.Mock;

/** CODE only — a prose mention of a removed symbol must not fail the scan. */
function screenCode(): string {
  return readFileSync(join('src', 'screens', 'securepro', 'SecureProMembersScreen.tsx'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^[ \t]*\{?\/\*[\s\S]*?\*\/\}?[ \t]*$/gm, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockInvite.mockResolvedValue({data: {id: 'm-new', status: 'pending'}});
  (familyApi.creditRequests as jest.Mock).mockResolvedValue({data: {requests: []}});
});

describe('B-832 — no member cap', () => {
  it('with 4 (and 40) active members the Add Member CTA renders', async () => {
    const four = [1, 2, 3, 4].map(member);
    mockMembers.mockResolvedValue({
      data: {members: four, total: 4, counts: {active: 4, pending: 0, held: 0}},
    });
    const four_ = render(<SecureProMembersScreen />);
    // Why: assert AFTER the roster lands — at mount the count is still 0, so a
    // cap gate would let a bare `findByText` pass before the data arrives.
    await four_.findByText('4 ACTIVE · 0 PENDING · BRAVO SECURE PRO');
    expect(four_.getByText('Add Member')).toBeTruthy();
    expect(four_.queryByLabelText('Request additional seats')).toBeNull();
    four_.unmount();

    const forty = Array.from({length: 40}, (_, i) => member(i + 1));
    mockMembers.mockResolvedValue({
      data: {members: forty, total: 40, counts: {active: 40, pending: 0, held: 0}},
    });
    const forty_ = render(<SecureProMembersScreen />);
    await forty_.findByText('40 ACTIVE · 0 PENDING · BRAVO SECURE PRO');
    expect(forty_.getByText('Add Member')).toBeTruthy();
    expect(forty_.queryByLabelText('Request additional seats')).toBeNull();
  });

  it('no seat-request path survives in the source (MAX_SEATS / requestSeats gone)', () => {
    const code = screenCode();
    // Self-check: the scan reads real code, so an absence assertion is not vacuous.
    expect(code).toContain('Add Member');
    expect(code).not.toMatch(/MAX_SEATS/);
    expect(code).not.toMatch(/requestSeats/);
    expect(code).not.toMatch(/seatRequestState/);
    expect(code).not.toMatch(/atCap/);
  });

  it('the header counts come from the SERVER, not from the loaded page', async () => {
    mockMembers.mockResolvedValue({
      data: {
        members: [member(1), member(2)],
        total: 900,
        counts: {active: 880, pending: 20, held: 3},
      },
    });
    const {findByText} = render(<SecureProMembersScreen />);
    expect(await findByText('880 ACTIVE · 20 PENDING · BRAVO SECURE PRO')).toBeTruthy();
  });

  it('an OLD server answering {members} only still renders counts from the list', async () => {
    mockMembers.mockResolvedValue({data: {members: [member(1), member(2), member(3)]}});
    const {findByText} = render(<SecureProMembersScreen />);
    expect(await findByText('3 ACTIVE · 0 PENDING · BRAVO SECURE PRO')).toBeTruthy();
  });
});

describe('B-833 — no relationship', () => {
  it('no RELATIONSHIP section renders and Add is enabled after picking a contact', async () => {
    mockMembers.mockResolvedValue({
      data: {members: [], total: 0, counts: {active: 0, pending: 0, held: 0}},
    });
    const utils = render(<SecureProMembersScreen />);

    fireEvent.press(await utils.findByLabelText('Add member'));
    fireEvent.press(await utils.findByLabelText(`Pick ${CONTACT.localName}`));

    const send = await utils.findByLabelText('Send invite');
    expect(utils.queryByText('RELATIONSHIP')).toBeNull();
    expect(utils.queryByText(/relationship/i)).toBeNull();
    expect(send.props.accessibilityState?.disabled).toBe(false);

    fireEvent.press(send);
    await waitFor(() => expect(mockInvite).toHaveBeenCalledTimes(1));
    // Two arguments only — the third (relationship) is gone from the wire.
    expect(mockInvite.mock.calls[0]).toEqual([CONTACT.phoneE164, null]);
  });

  it('the relationship picker is gone from the source', () => {
    const code = screenCode();
    expect(code).toContain('Send Invite');
    expect(code).not.toMatch(/RELATIONSHIPS/);
    expect(code).not.toMatch(/relBadge/);
    expect(code).not.toMatch(/\brelationship\b/i);
  });
});

describe('B-835 — paged roster', () => {
  it('Show more fetches the next offset and appends without duplicate ids', async () => {
    const page1 = Array.from({length: 50}, (_, i) => member(i + 1));
    // Page 2 re-serves m50 (a new row landed at the top mid-session) plus 10 new.
    const page2 = [member(50), ...Array.from({length: 10}, (_, i) => member(i + 51))];
    mockMembers
      .mockResolvedValueOnce({data: {members: page1, total: 60, counts: {active: 60, pending: 0, held: 0}}})
      .mockResolvedValueOnce({data: {members: page2, total: 60, counts: {active: 60, pending: 0, held: 0}}});

    const utils = render(<SecureProMembersScreen />);
    await waitFor(() => expect(utils.getAllByLabelText(/^Manage Member /)).toHaveLength(50));

    await act(async () => {
      fireEvent.press(utils.getByLabelText('Show more members'));
    });

    // 50 + 11 returned rows, one of which repeats m50 → 60 unique (A13).
    expect(utils.getAllByLabelText(/^Manage Member /)).toHaveLength(60);
    expect(mockMembers.mock.calls[1][0]).toMatchObject({limit: 50, offset: 50});
    // Everything loaded — the row retires.
    expect(utils.queryByLabelText('Show more members')).toBeNull();
  });

  it('Show more is absent when the server reports no more rows', async () => {
    mockMembers.mockResolvedValue({
      data: {members: [member(1)], total: 1, counts: {active: 1, pending: 0, held: 0}},
    });
    const utils = render(<SecureProMembersScreen />);
    await utils.findByLabelText('Manage Member 1');
    expect(utils.queryByLabelText('Show more members')).toBeNull();
  });

  it('a stale response for an older q is dropped', async () => {
    type Deferred = {resolve: (v: unknown) => void};
    const deferred: Deferred[] = [];
    mockMembers.mockImplementation(() => new Promise(resolve => { deferred.push({resolve}); }));

    const utils = render(<SecureProMembersScreen />);
    await waitFor(() => expect(mockMembers).toHaveBeenCalledTimes(1));
    await act(async () => {
      deferred[0].resolve({
        data: {members: [member(1)], total: 1, counts: {active: 1, pending: 0, held: 0}},
      });
    });

    const box = utils.getByLabelText('Search members');
    fireEvent.changeText(box, 'al');
    await waitFor(() => expect(mockMembers).toHaveBeenCalledTimes(2));

    fireEvent.changeText(box, 'ali');
    await waitFor(() => expect(mockMembers).toHaveBeenCalledTimes(3));

    // The NEWER query answers first…
    await act(async () => {
      deferred[2].resolve({
        data: {
          members: [{...member(7), name: 'Alice'}],
          total: 1, counts: {active: 1, pending: 0, held: 0},
        },
      });
    });
    await utils.findByLabelText('Manage Alice');

    // …and the older one, answering late, must not overwrite it.
    await act(async () => {
      deferred[1].resolve({
        data: {
          members: [{...member(8), name: 'Stale Bob'}],
          total: 1, counts: {active: 1, pending: 0, held: 0},
        },
      });
    });
    expect(utils.queryByLabelText('Manage Stale Bob')).toBeNull();
    expect(utils.queryByLabelText('Manage Alice')).toBeTruthy();
    expect(mockMembers.mock.calls[2][0]).toMatchObject({q: 'ali', offset: 0});
  });
});
