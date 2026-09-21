/**
 * Founder 2026-09-01 — "when we click any member, messenger chat must open up."
 *
 * A RENDER test on purpose. `openDirectChat.test.ts` proves the RULE (canonical
 * id, no re-seed, no self-thread, cross-shell route) and a source scan would
 * only prove the screen imports it. Neither can prove the row is actually
 * pressable, that it carries the right peer, or that the "(you)" row is inert —
 * a `onPress` wired to the wrong member, or a Card that renders the handler but
 * never fires it, leaves both of those green. Press the rows and assert.
 */
import React from 'react';
import {render, fireEvent, waitFor} from '@testing-library/react-native';

const mockOpenDirectChat = jest.fn((..._a: unknown[]) => true);
const mockListMembers = jest.fn();

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid', DIAL_CODES: []}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn(), getParent: () => undefined, getState: () => ({routeNames: [], routes: []})}),
  useRoute: () => ({params: {channelId: 'ch-1', channelName: 'Service Providers'}}),
  useFocusEffect: (cb: () => void | (() => void)) => { const R = require('react'); R.useEffect(() => cb(), []); },
}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));
jest.mock('@/modules/messenger/ui/AmbientBg', () => ({AmbientBg: 'AmbientBg'}));
jest.mock('../deptNoun', () => ({deptMemberNoun: () => 'Member', deptEmployeeNoun: () => 'Member'}));
jest.mock('@/modules/messenger/orgWorkspace/membershipIntents', () => ({drainMembershipIntents: jest.fn()}));
jest.mock('@store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({user: {id: 'me-1'}}),
}));
jest.mock('@/modules/messenger/store/messengerStore', () => ({
  useMessengerStore: {getState: () => ({setGroupMemberName: jest.fn()})},
}));
jest.mock('@services/api', () => ({
  departmentApi: {listMembers: (...a: unknown[]) => mockListMembers(...a)},
  orgApi: {listCpos: jest.fn()},
  tokenStore: {get: () => null},
}));
jest.mock('@screens/messenger/openDirectChat', () => ({
  openDirectChat: (...a: unknown[]) => mockOpenDirectChat(...a),
}));

import ChannelMembersScreen from '../ChannelMembersScreen';

const member = (user_id: string, display_name: string, over: Record<string, unknown> = {}) => ({
  user_id, display_name, role: 'admin', manageable: true, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockListMembers.mockResolvedValue({data: {members: [
    member('u-baine', 'Baine Kriel', {avatar_url: 'https://cdn.invalid/b.png'}),
    member('u-jack', 'Jack'),
    member('me-1', 'Ranger Danger', {manageable: false}),
  ]}});
});

describe('ChannelMembersScreen — member row opens the 1:1 chat', () => {
  it('opens the tapped member’s thread, with that member’s identity', async () => {
    const {getByLabelText} = render(<ChannelMembersScreen />);
    await waitFor(() => getByLabelText('Message Baine Kriel'));

    fireEvent.press(getByLabelText('Message Baine Kriel'));

    expect(mockOpenDirectChat).toHaveBeenCalledTimes(1);
    expect(mockOpenDirectChat.mock.calls[0][1]).toEqual({
      userId: 'u-baine', name: 'Baine Kriel', avatarUrl: 'https://cdn.invalid/b.png',
    });
  });

  it('a second, DIFFERENT member always passes the rapid-tap guard', async () => {
    const {getByLabelText} = render(<ChannelMembersScreen />);
    await waitFor(() => getByLabelText('Message Baine Kriel'));

    fireEvent.press(getByLabelText('Message Baine Kriel'));
    fireEvent.press(getByLabelText('Message Jack'));

    expect(mockOpenDirectChat).toHaveBeenCalledTimes(2);
    expect(mockOpenDirectChat.mock.calls[1][1]).toMatchObject({userId: 'u-jack'});
  });

  it('NAV-10 — a mash on the SAME member queues one open, not N', async () => {
    const {getByLabelText} = render(<ChannelMembersScreen />);
    await waitFor(() => getByLabelText('Message Baine Kriel'));

    const row = getByLabelText('Message Baine Kriel');
    fireEvent.press(row);
    fireEvent.press(row);
    fireEvent.press(row);

    expect(mockOpenDirectChat).toHaveBeenCalledTimes(1);
  });

  it('your own row is not a door to a thread with yourself', async () => {
    const {getByLabelText, queryByLabelText} = render(<ChannelMembersScreen />);
    await waitFor(() => getByLabelText('Message Baine Kriel'));

    expect(queryByLabelText('Message Ranger Danger')).toBeNull();
  });
});
