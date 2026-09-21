/**
 * B-854 — the chain, from the ROOT's side.
 *
 * A linked member B may hold members of their own. The chain lets B's members'
 * bookings come out of A's wallet, inside the allowance A already granted B —
 * so A's exposure never widens, but WHO can spend it does. That makes every
 * control here a money control:
 *
 *  · A must be able to SEE that B holds members at all, and that the chain is
 *    on. A badge that reads as a plan perk (A14) hides a spending arrangement
 *    behind something that looks like a subscription tier.
 *  · Approving is A's decision (A11), so it confirms and is guarded by a
 *    SYNCHRONOUS ref — a double-tap that approves twice is not idempotent on a
 *    request row, and the second call is an unexplained failure alert.
 *  · Switching it off can be REFUSED while bookings are still running on the
 *    chain (A10, `409 chained_bookings_in_flight`). "Please try again" there is
 *    a loop: the answer is a count and a reason.
 *  · A's member sheet must itemise WHO spent it. `memberSpend` keys the ledger
 *    on the actor, and for a chained charge the actor is B's member, not B —
 *    so without the "via" line A sees a total they cannot account for.
 */
import React from 'react';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {render, fireEvent, waitFor, act} from '@testing-library/react-native';
import SecureProMembersScreen from '@screens/securepro/SecureProMembersScreen';
import {familyApi} from '@services/api';
import {Alert} from '@utils/alert';

const mockRouteParams: {current: Record<string, unknown> | undefined} = {current: undefined};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn(), setParams: jest.fn()}),
  useRoute: () => ({params: mockRouteParams.current}),
  useFocusEffect: (cb: () => void) => {
    const react = require('react');
    react.useEffect(cb, []);
  },
}));

jest.mock('@services/api', () => ({
  familyApi: {
    members: jest.fn(),
    creditRequests: jest.fn().mockResolvedValue({data: {requests: []}}),
    memberSpend: jest.fn().mockResolvedValue({data: {member: {}, byFeature: [], transactions: []}}),
    invite: jest.fn(),
    setHold: jest.fn(),
    setLimit: jest.fn(),
    remove: jest.fn(),
    approveFundMembers: jest.fn(),
    declineFundMembers: jest.fn(),
    setFundMembers: jest.fn(),
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
  useDiscoveredContacts: () => ({matches: [], loading: false, permission: 'granted'}),
}));
jest.mock('@bravo/messenger-core', () => ({UsersHttpClient: class {}}));
jest.mock('@/modules/news/mapbox', () => ({buildPinMapUrl: () => ''}));
jest.mock('@store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({user: {phone_e164: '+971500000000'}}),
}));

const mockMembers = familyApi.members as jest.Mock;
const mockSpend = familyApi.memberSpend as jest.Mock;
const mockApprove = familyApi.approveFundMembers as jest.Mock;
const mockDecline = familyApi.declineFundMembers as jest.Mock;
const mockSetFund = familyApi.setFundMembers as jest.Mock;
const mockAlert = Alert.alert as unknown as jest.Mock;

type Row = Record<string, unknown>;
const member = (over: Row = {}): Row => ({
  id: 'row-b', memberId: 'u-b', name: 'Bea', avatarUrl: null,
  status: 'active', heldUntil: null,
  spendLimit: 5000, spent: 1200,
  invitedAt: '2026-08-01T00:00:00.000Z', acceptedAt: '2026-08-01T00:00:00.000Z',
  lastLocation: null,
  ...over,
});

const serveRoster = (...rows: Row[]) =>
  mockMembers.mockResolvedValue({
    data: {members: rows, total: rows.length, counts: {active: rows.length, pending: 0, held: 0}},
  });

/** Press the CONFIRM button of the last alert, the way a person would. */
async function confirmLastAlert(label: RegExp) {
  const call = mockAlert.mock.calls[mockAlert.mock.calls.length - 1];
  const buttons = call[2] as Array<{text: string; onPress?: () => void}>;
  const btn = buttons.find(b => label.test(b.text));
  expect(btn).toBeTruthy();
  await act(async () => { btn!.onPress?.(); });
}

/** CODE only — a prose mention of a banned word must not fail the scan. */
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
  mockRouteParams.current = undefined;
  (familyApi.creditRequests as jest.Mock).mockResolvedValue({data: {requests: []}});
  mockSpend.mockResolvedValue({data: {member: {}, byFeature: [], transactions: []}});
  mockApprove.mockResolvedValue({data: {row: member()}});
  mockDecline.mockResolvedValue({data: {row: member()}});
  mockSetFund.mockResolvedValue({data: {row: member()}});
});

describe('B-854 — the roster says who holds members and whose money funds them', () => {
  it('a member who holds members carries a count badge', async () => {
    serveRoster(member({holdsMembersCount: 2}));
    const u = render(<SecureProMembersScreen />);
    await u.findByLabelText('Manage Bea');
    expect(u.getByText('Holds 2 members')).toBeTruthy();
  });

  it('ONE member reads singular', async () => {
    serveRoster(member({holdsMembersCount: 1}));
    const u = render(<SecureProMembersScreen />);
    await u.findByLabelText('Manage Bea');
    expect(u.getByText('Holds 1 member')).toBeTruthy();
  });

  it('no badge at zero, and none on a ≤1.0.309 server that sends no count', async () => {
    serveRoster(member({holdsMembersCount: 0}), member({id: 'row-c', memberId: 'u-c', name: 'Cal'}));
    const u = render(<SecureProMembersScreen />);
    await u.findByLabelText('Manage Bea');
    expect(u.queryByText(/Holds \d+ member/)).toBeNull();
  });

  it('the CHAIN-ON badge says whose allowance pays', async () => {
    serveRoster(member({holdsMembersCount: 2, fundsSubMembers: true}));
    const u = render(<SecureProMembersScreen />);
    await u.findByLabelText('Manage Bea');
    expect(u.getByText(/Funds their members from you/i)).toBeTruthy();
  });

  it('the chain-on badge is absent while the chain is off', async () => {
    serveRoster(member({holdsMembersCount: 2, fundsSubMembers: false}));
    const u = render(<SecureProMembersScreen />);
    await u.findByLabelText('Manage Bea');
    expect(u.queryByText(/Funds their members from you/i)).toBeNull();
  });

  /**
   * A14 — `getMine`'s Pro root and the paying root can differ, so a badge
   * phrased as a plan perk ("on your Pro plan", "Pro member") would state
   * something the roster cannot know, about a row that is really about money.
   */
  it('neither badge reads as a Pro entitlement', () => {
    const code = screenCode();
    expect(code).toContain('Holds ');                    // self-check: the scan sees the badges
    expect(code).toContain('Funds their members from you');
    const badgeLines = code.split('\n').filter(l => /Holds |Funds their members/.test(l));
    expect(badgeLines.length).toBeGreaterThan(0);
    for (const line of badgeLines) {
      expect(line).not.toMatch(/\bPro\b/);
      expect(line).not.toMatch(/\bplan\b/i);
      expect(line).not.toMatch(/\bsubscri/i);
    }
  });
});

/**
 * P1-2 — the holder's wake names the `(A,B)` row, which lives on THIS roster.
 * Routing it through `focusRowId` (the member-side quota list) meant a
 * highlight that could never land: that list only ever holds rows where the
 * reader is the MEMBER.
 */
describe('B-854 — focusMemberRowId marks the roster row the wake was about', () => {
  it('highlights the named row and no other', async () => {
    mockRouteParams.current = {focusMemberRowId: 'row-b'};
    serveRoster(
      member({holdsMembersCount: 2}),
      member({id: 'row-c', memberId: 'u-c', name: 'Cal'}),
    );
    const u = render(<SecureProMembersScreen />);
    const row = await u.findByTestId('member-row-row-b');
    expect(row.props.accessibilityState?.selected).toBe(true);
    expect(u.getByTestId('member-row-row-c').props.accessibilityState?.selected).toBe(false);
  });

  it('an unknown id highlights nothing rather than the first row', async () => {
    mockRouteParams.current = {focusMemberRowId: 'row-nobody'};
    serveRoster(member({holdsMembersCount: 2}));
    const u = render(<SecureProMembersScreen />);
    const row = await u.findByTestId('member-row-row-b');
    expect(row.props.accessibilityState?.selected).toBe(false);
  });

  it('no param highlights nothing', async () => {
    serveRoster(member({holdsMembersCount: 2}));
    const u = render(<SecureProMembersScreen />);
    const row = await u.findByTestId('member-row-row-b');
    expect(row.props.accessibilityState?.selected).toBe(false);
  });
});

describe('B-854/A11 — the root decides, on the member sheet', () => {
  const openSheet = async () => {
    const u = render(<SecureProMembersScreen />);
    fireEvent.press(await u.findByLabelText('Manage Bea'));
    return u;
  };

  /**
   * The CONTRACT shape now carries the LATEST request of ANY status, so a
   * decided one arrives on the row for as long as it is the latest. Treating
   * "a request object exists" as "someone is waiting" would leave the
   * Allow/Decline card up forever after the root already answered.
   */
  it.each(['declined', 'approved', 'cancelled', 'expired'] as const)(
    'a %s request is NOT a pending ask', async status => {
      serveRoster(member({
        holdsMembersCount: 2,
        fundingRequest: {id: 'fr-1', status, createdAt: '2026-09-11T00:00:00.000Z'},
      }));
      const u = await openSheet();
      await u.findByLabelText('Remove member');
      expect(u.queryByText(/wants their members to spend your allowance/i)).toBeNull();
    },
  );

  it('a pending ask is shown as a decision, naming the member and the money', async () => {
    serveRoster(member({
      holdsMembersCount: 2,
      fundingRequest: {id: 'fr-1', status: 'pending', createdAt: '2026-09-11T00:00:00.000Z'},
    }));
    const u = await openSheet();
    expect(await u.findByText(/Bea wants their members to spend your allowance/i)).toBeTruthy();
    expect(u.getByLabelText(/Allow Bea’s members to spend your allowance/i)).toBeTruthy();
    expect(u.getByLabelText(/Decline Bea’s funding request/i)).toBeTruthy();
  });

  /**
   * The one wire tolerance kept: an interim build projected `{id, createdAt}`
   * from a pending-only subquery, with no `status`. Reading that as "decided"
   * would hide an ask the root was pushed about, so a status-less request is
   * pending.
   */
  it('a status-LESS request object still shows the decision card', async () => {
    serveRoster(member({
      holdsMembersCount: 2,
      fundingRequest: {id: 'fr-1', createdAt: '2026-09-11T00:00:00.000Z'} as never,
    }));
    const u = await openSheet();
    expect(await u.findByText(/Bea wants their members to spend your allowance/i)).toBeTruthy();
    expect(u.getByLabelText(/Allow Bea’s members to spend your allowance/i)).toBeTruthy();
  });

  /**
   * The server now answers `409 no_funding_request` to an approve with nothing
   * on file, which is the right server behaviour — but the CLIENT must never
   * get there. An "Allow" the holder can press with no pending request is a
   * money control wired to a refusal.
   */
  it('NO Allow affordance exists without a pending request — on any row shape', async () => {
    for (const over of [
      {fundingRequest: null},
      {fundingRequest: undefined},
      {fundingRequest: {id: 'fr-1', status: 'expired' as const, createdAt: '2026-09-11T00:00:00.000Z'}},
      {fundingRequest: {id: 'fr-1', status: 'declined' as const, createdAt: '2026-09-11T00:00:00.000Z'}},
      {fundingRequest: {id: 'fr-1', status: 'approved' as const, createdAt: '2026-09-11T00:00:00.000Z'}},
      {fundsSubMembers: true, fundingRequest: null},
    ]) {
      serveRoster(member({holdsMembersCount: 2, ...over}));
      const u = render(<SecureProMembersScreen />);
      fireEvent.press(await u.findByLabelText('Manage Bea'));
      await u.findByLabelText('Remove member');
      expect(u.queryByLabelText(/Allow Bea’s members to spend your allowance/i)).toBeNull();
      expect(u.queryByLabelText(/Decline Bea’s funding request/i)).toBeNull();
      u.unmount();
    }
  });

  it('no pending ask, no decision card', async () => {
    serveRoster(member({holdsMembersCount: 2, fundingRequest: null}));
    const u = await openSheet();
    // Anchor on a sheet-ONLY control: the member's name also renders on the
    // roster row underneath, so waiting on it would be ambiguous.
    await u.findByLabelText('Remove member');
    expect(u.queryByText(/wants their members to spend your allowance/i)).toBeNull();
    expect(u.queryByLabelText(/Allow Bea’s members/i)).toBeNull();
  });

  it('ALLOW confirms first, then approves the ROW', async () => {
    serveRoster(member({holdsMembersCount: 2, fundingRequest: {id: 'fr-1', status: 'pending'}}));
    const u = await openSheet();
    fireEvent.press(await u.findByLabelText(/Allow Bea’s members to spend your allowance/i));
    // The tap alone must not widen who can spend the root's money.
    expect(mockApprove).not.toHaveBeenCalled();
    await confirmLastAlert(/allow/i);
    await waitFor(() => expect(mockApprove).toHaveBeenCalledWith('row-b'));
  });

  it('DECLINE confirms first, then declines the ROW', async () => {
    serveRoster(member({holdsMembersCount: 2, fundingRequest: {id: 'fr-1', status: 'pending'}}));
    const u = await openSheet();
    fireEvent.press(await u.findByLabelText(/Decline Bea’s funding request/i));
    expect(mockDecline).not.toHaveBeenCalled();
    await confirmLastAlert(/decline/i);
    await waitFor(() => expect(mockDecline).toHaveBeenCalledWith('row-b'));
  });

  it('N4 — a double confirm approves exactly ONCE', async () => {
    serveRoster(member({holdsMembersCount: 2, fundingRequest: {id: 'fr-1', status: 'pending'}}));
    let release: (v: unknown) => void = () => {};
    mockApprove.mockReturnValue(new Promise(res => { release = res; }));
    const u = await openSheet();
    fireEvent.press(await u.findByLabelText(/Allow Bea’s members to spend your allowance/i));
    const buttons = mockAlert.mock.calls[mockAlert.mock.calls.length - 1][2] as
      Array<{text: string; onPress?: () => void}>;
    const go = buttons.find(b => /allow/i.test(b.text))!;
    // Two SYNCHRONOUS presses, before a re-render can disable anything.
    await act(async () => { go.onPress?.(); go.onPress?.(); });
    expect(mockApprove).toHaveBeenCalledTimes(1);
    await act(async () => { release({data: {row: member()}}); });
  });

  it('an approve refused on an inactive row says why (A9), not "try again"', async () => {
    serveRoster(member({holdsMembersCount: 2, fundingRequest: {id: 'fr-1', status: 'pending'}}));
    mockApprove.mockRejectedValue({
      response: {status: 400, data: {code: 'MEMBER_NOT_ACTIVE', message: 'MEMBER_NOT_ACTIVE'}},
    });
    const u = await openSheet();
    fireEvent.press(await u.findByLabelText(/Allow Bea’s members to spend your allowance/i));
    await confirmLastAlert(/allow/i);
    await waitFor(() => expect(mockAlert).toHaveBeenCalledWith(
      expect.any(String), expect.stringMatching(/isn’t active/i),
    ));
  });
});

describe('B-854/A10 — switching the chain off', () => {
  const openSheet = async () => {
    const u = render(<SecureProMembersScreen />);
    fireEvent.press(await u.findByLabelText('Manage Bea'));
    return u;
  };

  it('offers the off switch ONLY while the chain is on', async () => {
    serveRoster(member({holdsMembersCount: 2, fundsSubMembers: false}));
    const u = await openSheet();
    await u.findByLabelText('Remove member');
    expect(u.queryByLabelText(/Stop funding Bea’s members/i)).toBeNull();
  });

  it('confirms, then PATCHes the row to disabled', async () => {
    serveRoster(member({holdsMembersCount: 2, fundsSubMembers: true}));
    const u = await openSheet();
    fireEvent.press(await u.findByLabelText(/Stop funding Bea’s members/i));
    expect(mockSetFund).not.toHaveBeenCalled();
    await confirmLastAlert(/stop|turn off/i);
    await waitFor(() => expect(mockSetFund).toHaveBeenCalledWith('row-b', false));
  });

  it('a 409 while their bookings are still running quotes the COUNT', async () => {
    serveRoster(member({holdsMembersCount: 2, fundsSubMembers: true}));
    mockSetFund.mockRejectedValue({
      response: {status: 409, data: {code: 'chained_bookings_in_flight', message: 'chained_bookings_in_flight', count: 2}},
    });
    const u = await openSheet();
    fireEvent.press(await u.findByLabelText(/Stop funding Bea’s members/i));
    await confirmLastAlert(/stop|turn off/i);
    await waitFor(() => expect(mockAlert).toHaveBeenCalledWith(
      expect.any(String),
      '2 of their members’ bookings are still in progress. Try again when they finish.',
    ));
    // No raw wire code may reach the root.
    const bodies = mockAlert.mock.calls.map(c => String(c[1] ?? ''));
    expect(bodies.some(b => b.includes('chained_bookings_in_flight'))).toBe(false);
  });

  it('N4 — a double confirm switches it off exactly ONCE', async () => {
    serveRoster(member({holdsMembersCount: 2, fundsSubMembers: true}));
    let release: (v: unknown) => void = () => {};
    mockSetFund.mockReturnValue(new Promise(res => { release = res; }));
    const u = await openSheet();
    fireEvent.press(await u.findByLabelText(/Stop funding Bea’s members/i));
    const buttons = mockAlert.mock.calls[mockAlert.mock.calls.length - 1][2] as
      Array<{text: string; onPress?: () => void}>;
    const go = buttons.find(b => /stop|turn off/i.test(b.text))!;
    await act(async () => { go.onPress?.(); go.onPress?.(); });
    expect(mockSetFund).toHaveBeenCalledTimes(1);
    await act(async () => { release({data: {row: member()}}); });
  });
});

/**
 * A6 — the ledger actor for a chained charge is B's member, not B. A's sheet is
 * keyed on B's row, so without the "via" line A reads a total with no owner.
 */
describe('B-854/A6 — "{actor} via {member}" on the spend lines', () => {
  const tx = (over: Record<string, unknown> = {}) => ({
    id: 'tx-1', type: 'payment', feature: 'booking',
    description: 'Protection booking', amount: -258, bookingId: 'bk-1',
    at: '2026-09-10T09:00:00.000Z',
    ...over,
  });

  it('names the sub-member and the member it came through', async () => {
    serveRoster(member({holdsMembersCount: 1, fundsSubMembers: true}));
    mockSpend.mockResolvedValue({
      data: {
        member: {id: 'row-b', name: 'Bea', spent: 258, spendLimit: 5000},
        byFeature: [{feature: 'booking', spent: 258, refunded: 0, count: 1}],
        transactions: [tx({actorName: 'Cleo', viaUserId: 'u-c'})],
      },
    });
    const u = render(<SecureProMembersScreen />);
    fireEvent.press(await u.findByLabelText('Manage Bea'));
    expect(await u.findByText('Cleo via Bea · Protection booking')).toBeTruthy();
  });

  it('a one-hop row keeps today\'s plain feature label', async () => {
    serveRoster(member({holdsMembersCount: 0}));
    mockSpend.mockResolvedValue({
      data: {
        member: {id: 'row-b', name: 'Bea', spent: 258, spendLimit: 5000},
        // `byFeature` renders the SAME label above the rows; left empty so the
        // one match below is unambiguously the transaction line.
        byFeature: [],
        transactions: [tx()],
      },
    });
    const u = render(<SecureProMembersScreen />);
    fireEvent.press(await u.findByLabelText('Manage Bea'));
    expect(await u.findByText('Protection booking')).toBeTruthy();
    expect(u.queryByText(/ via /)).toBeNull();
  });

  it('a chained row whose actor the server did not name still says "via"', async () => {
    // The via-ness is the load-bearing half: a missing NAME must not silently
    // render the charge as the member's own.
    serveRoster(member({holdsMembersCount: 1, fundsSubMembers: true}));
    mockSpend.mockResolvedValue({
      data: {
        member: {id: 'row-b', name: 'Bea', spent: 258, spendLimit: 5000},
        byFeature: [],
        transactions: [tx({actorName: null, viaUserId: 'u-c'})],
      },
    });
    const u = render(<SecureProMembersScreen />);
    fireEvent.press(await u.findByLabelText('Manage Bea'));
    expect(await u.findByText(/ via Bea · Protection booking/)).toBeTruthy();
  });
});
