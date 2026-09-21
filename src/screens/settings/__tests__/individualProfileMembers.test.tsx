/**
 * B-832 / B-835 — the UNGATED holder surface (B-724 put member management here
 * because the Pro sheet is plan-gated) must lose the 4-seat model too.
 *
 * The old screen hard-coded `MAX_SEATS = 4`: a four-bar capacity meter, four
 * fixed avatar slots, "Family Members · n / 4 Max", and a toast that refused
 * the add outright at four. None of that can survive an unlimited roster, and
 * a roster of thousands has to be searchable and paged like the Pro sheet.
 *
 * RED-first against the pre-fix screen: the section reads "Family Members ·
 * 4 / 4 Max", pressing add at four raises "Family is full (4 members max)."
 * instead of opening the invite modal, and there is no search box.
 */
import React from 'react';
import {render, fireEvent, waitFor, act} from '@testing-library/react-native';

const mockMembers = jest.fn();
const mockUsage = jest.fn();
const mockCreditRequests = jest.fn();
const mockMembership = jest.fn();

jest.mock('@services/api', () => ({
  familyApi: {
    members:        (...a: unknown[]) => mockMembers(...a),
    usage:          (...a: unknown[]) => mockUsage(...a),
    creditRequests: (...a: unknown[]) => mockCreditRequests(...a),
    membership:     (...a: unknown[]) => mockMembership(...a),
    // B-843 — the quota card this screen mounts now reads every root; the
    // fallback below keeps these cases on the single-membership path.
    memberships:    jest.fn().mockRejectedValue({response: {status: 404, data: {}}}),
    invite:         jest.fn().mockResolvedValue({data: {}}),
    setLimit:       jest.fn().mockResolvedValue({data: {}}),
    remove:         jest.fn().mockResolvedValue({data: {}}),
    approveCredit:  jest.fn().mockResolvedValue({data: {}}),
    rejectCredit:   jest.fn().mockResolvedValue({data: {}}),
    requestCredit:  jest.fn(),
    cancelCredit:   jest.fn(),
  },
}));
jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn()}),
  // B-843/A11 — the screen reads `focusHolderId` off the route to highlight the
  // quota card a money refusal named. No params here: these cases are the
  // holder surface, reached without one.
  useRoute: () => ({params: undefined}),
  useFocusEffect: (cb: () => void | (() => void)) => {
    const React2 = require('react');
    React2.useEffect(cb, []);
  },
}));
jest.mock('@store/authStore', () => ({
  useAuthStore: () => ({user: {full_name: 'Root Holder', phone_e164: '+971500000000'}}),
}));

import IndividualProfileScreen from '../IndividualProfileScreen';

const member = (i: number, status: 'active' | 'pending' = 'active') => ({
  id: `m${i}`, memberId: `u${i}`, name: `Member ${i}`, avatarUrl: null,
  status, heldUntil: null, spendLimit: null, spent: 0,
  invitedAt: '2026-08-01T00:00:00.000Z', acceptedAt: null, lastLocation: null,
});

const page = (members: unknown[], over: Record<string, unknown> = {}) => ({
  data: {
    members,
    total: members.length,
    counts: {active: members.length, pending: 0, held: 0},
    ...over,
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockMembers.mockResolvedValue(page([]));
  mockUsage.mockResolvedValue({data: {totalSpent: 0, members: [], recent: []}});
  mockCreditRequests.mockResolvedValue({data: {requests: []}});
  mockMembership.mockResolvedValue({data: {membership: null}});
});

describe('B-832 — the ungated holder surface is uncapped', () => {
  it('renders no "/ 4 Max" and no seat meter at four members', async () => {
    const four = [1, 2, 3, 4].map(i => member(i));
    mockMembers.mockResolvedValue(page(four));
    const utils = render(<IndividualProfileScreen />);

    await utils.findByText('Members · 4 active');
    expect(utils.queryByText(/\/ 4 Max/)).toBeNull();
    expect(utils.queryByText(/seats used/i)).toBeNull();
    expect(utils.queryByText(/AVAILABLE/)).toBeNull();
  });

  it('adding a fifth member is not refused with a cap toast', async () => {
    const four = [1, 2, 3, 4].map(i => member(i));
    mockMembers.mockResolvedValue(page(four));
    const utils = render(<IndividualProfileScreen />);
    await utils.findByText('Members · 4 active');

    fireEvent.press(utils.getByLabelText('Add a member'));

    // The invite modal opened…
    expect(await utils.findByPlaceholderText('+971 50 123 4567')).toBeTruthy();
    // …and no cap message was raised, in either the old or the new wording.
    expect(utils.queryByText(/Family is full/i)).toBeNull();
    expect(utils.queryByText(/Member limit reached/i)).toBeNull();
  });

  it('names pending members alongside active ones', async () => {
    mockMembers.mockResolvedValue({
      data: {
        members: [member(1), member(2), member(3, 'pending')],
        total: 3,
        counts: {active: 2, pending: 1, held: 0},
      },
    });
    const utils = render(<IndividualProfileScreen />);
    expect(await utils.findByText('Members · 2 active · 1 pending')).toBeTruthy();
  });
});

describe('B-835 — the ungated roster is searchable and paged', () => {
  it('Show more fetches the next offset and merges by id', async () => {
    const page1 = Array.from({length: 50}, (_, i) => member(i + 1));
    const page2 = [member(50), ...Array.from({length: 5}, (_, i) => member(i + 51))];
    mockMembers
      .mockResolvedValueOnce({data: {members: page1, total: 55, counts: {active: 55, pending: 0, held: 0}}})
      .mockResolvedValueOnce({data: {members: page2, total: 55, counts: {active: 55, pending: 0, held: 0}}});

    const utils = render(<IndividualProfileScreen />);
    await waitFor(() => expect(utils.getAllByLabelText(/^Remove Member /)).toHaveLength(50));

    await act(async () => {
      fireEvent.press(utils.getByLabelText('Show more members'));
    });

    expect(utils.getAllByLabelText(/^Remove Member /)).toHaveLength(55);
    expect(mockMembers.mock.calls[1][0]).toMatchObject({limit: 50, offset: 50});
  });

  it('typing in the search box re-issues the roster query at offset 0', async () => {
    mockMembers.mockResolvedValue(page([member(1), member(2)]));
    const utils = render(<IndividualProfileScreen />);
    await utils.findByText('Members · 2 active');

    fireEvent.changeText(utils.getByLabelText('Search members'), 'ali');
    await waitFor(() => expect(mockMembers).toHaveBeenCalledTimes(2));
    expect(mockMembers.mock.calls[1][0]).toMatchObject({q: 'ali', offset: 0});
  });
});

describe('A17 — spend outside the top 50 is still visible', () => {
  it('renders an "Others" bar when the server counts more members than it listed', async () => {
    mockMembers.mockResolvedValue(page([member(1)]));
    mockUsage.mockResolvedValue({
      data: {
        totalSpent: 9000,
        memberCount: 61,
        othersSpent: 4000,
        members: [{id: 'm1', name: 'Member 1', spent: 5000, spendLimit: null, sharePct: 56}],
        recent: [],
      },
    });
    const utils = render(<IndividualProfileScreen />);
    expect(await utils.findByText('Others (60 members)')).toBeTruthy();
    expect(utils.getByText(/4,000/)).toBeTruthy();
  });

  it('renders no "Others" bar when every member is listed', async () => {
    mockMembers.mockResolvedValue(page([member(1)]));
    mockUsage.mockResolvedValue({
      data: {
        totalSpent: 5000,
        memberCount: 1,
        othersSpent: 0,
        members: [{id: 'm1', name: 'Member 1', spent: 5000, spendLimit: null, sharePct: 100}],
        recent: [],
      },
    });
    const utils = render(<IndividualProfileScreen />);
    await utils.findByText('Credit Usage');
    expect(utils.queryByText(/^Others \(/)).toBeNull();
  });
});
