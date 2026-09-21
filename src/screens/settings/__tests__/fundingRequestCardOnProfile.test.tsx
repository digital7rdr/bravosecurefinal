/**
 * B-854 — the B-724 trap, closed for the funding decision.
 *
 * A holder does NOT need a Bravo Secure Pro plan to have linked members: B-724
 * moved member management onto `IndividualProfileScreen` precisely because
 * `SecureProMembersScreen` sits behind `useProPlanGate`, which fails CLOSED and
 * bounces a non-Pro holder to the Pro sales screen.
 *
 * The chained-funding ask is the same shape of decision as a credit request, so
 * it inherits the same rule: a non-Pro holder who is PUSHED about it must be
 * able to answer it on the ungated surface. The first cut put the Allow/Decline
 * card only on the Pro sheet — notified, and unable to act.
 *
 * RED-first against that cut: this screen renders no funding card at all.
 */
import React from 'react';
import {render, fireEvent, waitFor, act} from '@testing-library/react-native';

const mockMembers = jest.fn();
const mockUsage = jest.fn();
const mockCreditRequests = jest.fn();
const mockMembership = jest.fn();
const mockApprove = jest.fn();
const mockDecline = jest.fn();
const mockAlert = jest.fn();

jest.mock('@services/api', () => ({
  familyApi: {
    members:        (...a: unknown[]) => mockMembers(...a),
    usage:          (...a: unknown[]) => mockUsage(...a),
    creditRequests: (...a: unknown[]) => mockCreditRequests(...a),
    membership:     (...a: unknown[]) => mockMembership(...a),
    memberships:    jest.fn().mockRejectedValue({response: {status: 404, data: {}}}),
    invite:         jest.fn().mockResolvedValue({data: {}}),
    setLimit:       jest.fn().mockResolvedValue({data: {}}),
    remove:         jest.fn().mockResolvedValue({data: {}}),
    approveCredit:  jest.fn().mockResolvedValue({data: {}}),
    rejectCredit:   jest.fn().mockResolvedValue({data: {}}),
    requestCredit:  jest.fn(),
    cancelCredit:   jest.fn(),
    approveFundMembers: (...a: unknown[]) => mockApprove(...a),
    declineFundMembers: (...a: unknown[]) => mockDecline(...a),
    setFundMembers:     jest.fn(),
    requestFundMembers: jest.fn(),
  },
}));
jest.mock('@utils/alert', () => ({Alert: {alert: (...a: unknown[]) => mockAlert(...a)}}));
const mockRouteParams: {current: Record<string, unknown> | undefined} = {current: undefined};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn(), setParams: jest.fn()}),
  useRoute: () => ({params: mockRouteParams.current}),
  useFocusEffect: (cb: () => void | (() => void)) => {
    const React2 = require('react');
    React2.useEffect(cb, []);
  },
}));
// The holder here is deliberately NOT on a Pro plan — that is the whole point.
jest.mock('@store/authStore', () => ({
  useAuthStore: () => ({user: {
    full_name: 'Root Holder', phone_e164: '+971500000000',
    subscription_tier: 'lite', pro_active_until: null,
  }}),
}));

import IndividualProfileScreen from '../IndividualProfileScreen';

const member = (over: Record<string, unknown> = {}) => ({
  id: 'row-b', memberId: 'u-b', name: 'Bea', avatarUrl: null,
  status: 'active', heldUntil: null, spendLimit: 5000, spent: 1200,
  invitedAt: '2026-08-01T00:00:00.000Z', acceptedAt: '2026-08-01T00:00:00.000Z',
  lastLocation: null,
  ...over,
});

const page = (members: unknown[]) => ({
  data: {members, total: members.length, counts: {active: members.length, pending: 0, held: 0}},
});

/** Press the CONFIRM button of the last alert, the way a person would. */
async function confirmLastAlert(label: RegExp) {
  const call = mockAlert.mock.calls[mockAlert.mock.calls.length - 1];
  const buttons = call[2] as Array<{text: string; onPress?: () => void}>;
  const btn = buttons.find(b => label.test(b.text));
  expect(btn).toBeTruthy();
  await act(async () => { btn!.onPress?.(); });
}

const pendingAsk = {id: 'fr-1', status: 'pending' as const, createdAt: '2026-09-11T00:00:00.000Z'};

beforeEach(() => {
  jest.clearAllMocks();
  mockRouteParams.current = undefined;
  mockMembers.mockResolvedValue(page([]));
  mockUsage.mockResolvedValue({data: {totalSpent: 0, members: [], recent: []}});
  mockCreditRequests.mockResolvedValue({data: {requests: []}});
  mockMembership.mockResolvedValue({data: {membership: null}});
  mockApprove.mockResolvedValue({data: {row: member()}});
  mockDecline.mockResolvedValue({data: {row: member()}});
});

describe('B-854 — a NON-Pro holder can answer the funding ask here', () => {
  it('renders the decision card on the roster row that is waiting', async () => {
    mockMembers.mockResolvedValue(page([member({holdsMembersCount: 2, fundingRequest: pendingAsk})]));
    const u = render(<IndividualProfileScreen />);
    expect(await u.findByText(/Bea wants their members to spend your allowance/i)).toBeTruthy();
    expect(u.getByLabelText(/Allow Bea’s members to spend your allowance/i)).toBeTruthy();
    expect(u.getByLabelText(/Decline Bea’s funding request/i)).toBeTruthy();
  });

  it('renders NOTHING for a member with no open ask', async () => {
    mockMembers.mockResolvedValue(page([member({holdsMembersCount: 2, fundingRequest: null})]));
    const u = render(<IndividualProfileScreen />);
    await u.findByText('Bea');
    expect(u.queryByText(/wants their members to spend your allowance/i)).toBeNull();
  });

  it('ALLOW confirms first, then approves the ROW — same contract as the Pro sheet', async () => {
    mockMembers.mockResolvedValue(page([member({holdsMembersCount: 2, fundingRequest: pendingAsk})]));
    const u = render(<IndividualProfileScreen />);
    fireEvent.press(await u.findByLabelText(/Allow Bea’s members to spend your allowance/i));
    // The tap alone must not widen who can spend the holder's money.
    expect(mockApprove).not.toHaveBeenCalled();
    await confirmLastAlert(/allow/i);
    await waitFor(() => expect(mockApprove).toHaveBeenCalledWith('row-b'));
  });

  it('DECLINE confirms first, then declines the ROW', async () => {
    mockMembers.mockResolvedValue(page([member({holdsMembersCount: 2, fundingRequest: pendingAsk})]));
    const u = render(<IndividualProfileScreen />);
    fireEvent.press(await u.findByLabelText(/Decline Bea’s funding request/i));
    expect(mockDecline).not.toHaveBeenCalled();
    await confirmLastAlert(/decline/i);
    await waitFor(() => expect(mockDecline).toHaveBeenCalledWith('row-b'));
  });

  it('N4 — a double confirm approves exactly ONCE', async () => {
    mockMembers.mockResolvedValue(page([member({holdsMembersCount: 2, fundingRequest: pendingAsk})]));
    let release: (v: unknown) => void = () => {};
    mockApprove.mockReturnValue(new Promise(res => { release = res; }));
    const u = render(<IndividualProfileScreen />);
    fireEvent.press(await u.findByLabelText(/Allow Bea’s members to spend your allowance/i));
    const buttons = mockAlert.mock.calls[mockAlert.mock.calls.length - 1][2] as
      Array<{text: string; onPress?: () => void}>;
    const go = buttons.find(b => /allow/i.test(b.text))!;
    // Two SYNCHRONOUS presses, before any re-render can disable anything.
    await act(async () => { go.onPress?.(); go.onPress?.(); });
    expect(mockApprove).toHaveBeenCalledTimes(1);
    await act(async () => { release({data: {row: member()}}); });
  });

  it('a refusal says why, and no raw wire code reaches the holder', async () => {
    mockMembers.mockResolvedValue(page([member({holdsMembersCount: 2, fundingRequest: pendingAsk})]));
    mockApprove.mockRejectedValue({
      response: {status: 400, data: {code: 'MEMBER_NOT_ACTIVE', message: 'MEMBER_NOT_ACTIVE'}},
    });
    const u = render(<IndividualProfileScreen />);
    fireEvent.press(await u.findByLabelText(/Allow Bea’s members to spend your allowance/i));
    await confirmLastAlert(/allow/i);
    await waitFor(() => expect(mockAlert).toHaveBeenCalledWith(
      expect.any(String), expect.stringMatching(/isn’t active/i),
    ));
    const bodies = mockAlert.mock.calls.map(c => String(c[1] ?? ''));
    expect(bodies.some(b => b.includes('MEMBER_NOT_ACTIVE'))).toBe(false);
  });

  /**
   * P1-2 — the HOLDER's wake carries the `(A,B)` row id. That row lives on
   * their ROSTER, never in `FamilyQuotaCard` (which lists rows where the reader
   * is the MEMBER), so routing it through `focusRowId` meant a highlight that
   * could never land on anything.
   */
  it('focusMemberRowId highlights the ROSTER row the wake was about', async () => {
    mockRouteParams.current = {focusMemberRowId: 'row-b'};
    mockMembers.mockResolvedValue(page([
      member({holdsMembersCount: 2, fundingRequest: pendingAsk}),
      member({id: 'row-c', memberId: 'u-c', name: 'Cal'}),
    ]));
    const u = render(<IndividualProfileScreen />);
    const row = await u.findByTestId('member-row-row-b');
    expect(row.props.accessibilityState?.selected).toBe(true);
    expect(u.getByTestId('member-row-row-c').props.accessibilityState?.selected).toBe(false);
  });

  it('an unknown focusMemberRowId highlights nothing rather than the first row', async () => {
    mockRouteParams.current = {focusMemberRowId: 'row-nobody'};
    mockMembers.mockResolvedValue(page([member({holdsMembersCount: 2})]));
    const u = render(<IndividualProfileScreen />);
    const row = await u.findByTestId('member-row-row-b');
    expect(row.props.accessibilityState?.selected).toBe(false);
  });

  it('the MEMBER-side focusRowId never highlights a roster row', async () => {
    // Same id space, opposite side. A member-side param must not reach here.
    mockRouteParams.current = {focusRowId: 'row-b'};
    mockMembers.mockResolvedValue(page([member({holdsMembersCount: 2})]));
    const u = render(<IndividualProfileScreen />);
    const row = await u.findByTestId('member-row-row-b');
    expect(row.props.accessibilityState?.selected).toBe(false);
  });

  it('a decided ask is gone from this surface too', async () => {
    mockMembers.mockResolvedValue(page([member({
      holdsMembersCount: 2,
      fundingRequest: {id: 'fr-1', status: 'declined', createdAt: '2026-09-11T00:00:00.000Z'},
    })]));
    const u = render(<IndividualProfileScreen />);
    await u.findByText('Bea');
    expect(u.queryByText(/wants their members to spend your allowance/i)).toBeNull();
  });
});
