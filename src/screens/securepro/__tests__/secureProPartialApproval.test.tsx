/**
 * Spec §14 — the root may approve LESS than the member asked for.
 *
 * The server has supported this since B-709 (`resolveApprovedAmount`, and
 * `approveCredit(id, approvedCredits)` on the API client), but the holder
 * screen only ever called `approveCredit(req.id)` — approve in full. The one
 * comment claiming "partial approval is offered as a separate prompt" described
 * a prompt that did not exist, so the capability was unreachable from the app.
 *
 * RED-first: against the old screen `getByLabelText(/Approve a different
 * amount/)` throws — there was no such control.
 *
 * What these assert beyond "a button exists":
 *  · the AMOUNT reaches the API (a control that always sent the full request
 *    would look identical on screen);
 *  · §30's rules gate the confirm, so a holder cannot send 0, a negative, or
 *    more than was requested;
 *  · §14's confirmation names BOTH figures, and takes the GRANTED number from
 *    the server response rather than the one typed here.
 */
import React from 'react';
import {render, fireEvent, waitFor} from '@testing-library/react-native';
import SecureProMembersScreen from '@screens/securepro/SecureProMembersScreen';
import {familyApi} from '@services/api';
import {Alert} from '@utils/alert';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn(), setParams: jest.fn()}),
  // B-854/P1-2 — the screen reads `focusMemberRowId` off the route to mark the
  // roster row a funding wake named. These cases reach it without one.
  useRoute: () => ({params: undefined}),
  useFocusEffect: (cb: () => void) => {
    const react = require('react');
    react.useEffect(cb, []);
  },
}));

jest.mock('@services/api', () => ({
  familyApi: {
    members: jest.fn(),
    creditRequests: jest.fn(),
    approveCredit: jest.fn(),
    rejectCredit: jest.fn(),
    requestSeats: jest.fn(),
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
  useDiscoveredContacts: () => ({matches: [], loading: false, permission: 'granted'}),
}));
jest.mock('@bravo/messenger-core', () => ({UsersHttpClient: class {}}));
jest.mock('@/modules/news/mapbox', () => ({buildPinMapUrl: () => ''}));
jest.mock('@store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({user: {phone_e164: '+971500000000'}}),
}));

const mockMembers  = familyApi.members as jest.Mock;
const mockRequests = familyApi.creditRequests as jest.Mock;
const mockApprove  = familyApi.approveCredit as jest.Mock;
const mockAlert    = Alert.alert as jest.Mock;

const REQUEST = {
  id: 'req-1', familyRowId: 'm1', holderId: 'h1', memberId: 'u1',
  memberName: 'Alice', requestedCredits: 5000, approvedCredits: null,
  reason: 'School fees', status: 'pending' as const, decisionReason: null,
  createdAt: '2026-09-01T00:00:00.000Z', decidedAt: null,
  expiresAt: '2026-09-08T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockMembers.mockResolvedValue({data: {members: [{
    id: 'm1', memberId: 'u1', name: 'Alice', avatarUrl: null,
    status: 'active', heldUntil: null,
    spendLimit: 5000, spent: 5000,
    invitedAt: '2026-08-01T00:00:00.000Z', acceptedAt: '2026-08-01T00:00:00.000Z',
    lastLocation: null,
  }]}});
  mockRequests.mockResolvedValue({data: {requests: [REQUEST]}});
  mockApprove.mockResolvedValue({data: {
    ok: true, requestId: 'req-1', approvedCredits: 2000,
    previousLimit: 5000, newLimit: 7000, partial: true,
  }});
});

const openPartial = async (utils: ReturnType<typeof render>) => {
  await waitFor(() => utils.getByLabelText(/Approve a different amount/i));
  fireEvent.press(utils.getByLabelText(/Approve a different amount/i));
};

describe('SecureProMembersScreen — §14 partial approval', () => {
  it('sends the TYPED amount, not the requested one', async () => {
    const utils = render(<SecureProMembersScreen />);
    await openPartial(utils);

    fireEvent.changeText(utils.getByLabelText('Amount to approve, in credits'), '2000');
    fireEvent.press(utils.getByLabelText('Approve 2000 of 5000 credits for Alice'));

    await waitFor(() => expect(mockApprove).toHaveBeenCalled());
    expect(mockApprove).toHaveBeenCalledWith('req-1', 2000);
  });

  it('the full-approve button still approves in full', async () => {
    const utils = render(<SecureProMembersScreen />);
    await waitFor(() => utils.getByLabelText('Approve 5000 credits for Alice'));

    fireEvent.press(utils.getByLabelText('Approve 5000 credits for Alice'));

    await waitFor(() => expect(mockApprove).toHaveBeenCalled());
    expect(mockApprove).toHaveBeenCalledWith('req-1', null);
  });

  it('§14 — the confirmation names BOTH figures on a partial approval', async () => {
    const utils = render(<SecureProMembersScreen />);
    await openPartial(utils);
    fireEvent.changeText(utils.getByLabelText('Amount to approve, in credits'), '2000');
    fireEvent.press(utils.getByLabelText('Approve 2000 of 5000 credits for Alice'));

    await waitFor(() => expect(mockAlert).toHaveBeenCalled());
    const [title, body] = mockAlert.mock.calls[0];
    expect(title).toBe('Partially approved');
    expect(body).toContain('5,000');   // requested
    expect(body).toContain('2,000');   // approved
    expect(body).toContain('7,000');   // the server's new limit
  });

  it('reports the SERVER granted amount even when it differs from what was typed', async () => {
    mockApprove.mockResolvedValue({data: {
      ok: true, requestId: 'req-1', approvedCredits: 1500,
      previousLimit: 5000, newLimit: 6500, partial: true,
    }});
    const utils = render(<SecureProMembersScreen />);
    await openPartial(utils);
    fireEvent.changeText(utils.getByLabelText('Amount to approve, in credits'), '2000');
    fireEvent.press(utils.getByLabelText('Approve 2000 of 5000 credits for Alice'));

    await waitFor(() => expect(mockAlert).toHaveBeenCalled());
    expect(mockAlert.mock.calls[0][1]).toContain('1,500');
  });

  it('§30 — 0, a negative, a non-number and more-than-requested cannot be sent', async () => {
    const utils = render(<SecureProMembersScreen />);
    await openPartial(utils);
    const input = utils.getByLabelText('Amount to approve, in credits');

    for (const bad of ['0', '-100', 'abc', '', '5001']) {
      fireEvent.changeText(input, bad);
      fireEvent.press(utils.getByLabelText(/^Approve \d+ of 5000 credits for Alice$/));
      expect(mockApprove).not.toHaveBeenCalled();
    }

    // …and the very next valid amount goes through, so the gate is the VALUE
    // and not a stuck disabled flag.
    fireEvent.changeText(input, '4999');
    fireEvent.press(utils.getByLabelText('Approve 4999 of 5000 credits for Alice'));
    await waitFor(() => expect(mockApprove).toHaveBeenCalledWith('req-1', 4999));
  });

  it('the exact requested amount is allowed through the partial input', async () => {
    const utils = render(<SecureProMembersScreen />);
    await openPartial(utils);
    fireEvent.changeText(utils.getByLabelText('Amount to approve, in credits'), '5000');
    fireEvent.press(utils.getByLabelText('Approve 5000 of 5000 credits for Alice'));
    await waitFor(() => expect(mockApprove).toHaveBeenCalledWith('req-1', 5000));
  });
});
