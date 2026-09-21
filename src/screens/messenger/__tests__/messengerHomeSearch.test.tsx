/**
 * The chat-list search box — B-838, and the test debt A1 found on the way in.
 *
 * Founder 2026-08-24 asked for "search like WhatsApp", and the answer was a
 * TWO-LANE union: an in-memory scan of each conversation's name/peer/last-30
 * bodies, UNIONed with a full-history SQLCipher body scan whose hits arrive as
 * a set of conversation ids. **Neither lane had a single test.** A refactor
 * that dropped the union arm would have taken full-history search away and no
 * suite would have noticed.
 *
 * B-838 then widened what the second lane can return: media rows, whose text
 * is a caption or a FILE NAME. So this pins both halves at once —
 *   1. a conversation whose NAME does not match still shows when the body lane
 *      found something in it, and
 *   2. a media hit renders as the document it is.
 */
import React from 'react';
import {render, fireEvent, waitFor} from '@testing-library/react-native';

const mockSearchMessages = jest.fn();
const mockNavigate = jest.fn();

const mockState: Record<string, unknown> = {
  conversations: {
    'c-alice': {id: 'c-alice', type: 'direct', name: 'Alice', participants: [],
      peer: {userId: 'u-alice'}, unread_count: 0,
      last_message: {id: 'lm1', content: 'see you then', created_at: '2026-09-09T10:00:00.000Z'}},
    'c-bob': {id: 'c-bob', type: 'direct', name: 'Bob', participants: [],
      peer: {userId: 'u-bob'}, unread_count: 0,
      last_message: {id: 'lm2', content: 'ok', created_at: '2026-09-08T10:00:00.000Z'}},
  },
  conversationOrder: ['c-alice', 'c-bob'],
  connection: 'connected',
  undecryptableDropCount: 0,
  messages: {},
  deptConversationIds: {},
  directoryNames: {},
  presence: {},
  typing: {},
  drafts: {},
  setConversationMuted: jest.fn(),
  setConversationPinned: jest.fn(),
  removeConversation: jest.fn(),
  rememberDeptConversation: jest.fn(),
};

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({
    navigate: mockNavigate, goBack: jest.fn(), canGoBack: () => true,
    setParams: jest.fn(), addListener: () => () => undefined,
    getParent: () => undefined, getState: () => ({routeNames: []}),
  }),
  useRoute: () => ({params: {}}),
  useIsFocused: () => true,
  useFocusEffect: (cb: () => void | (() => void)) => {
    const R = require('react');
    R.useEffect(() => cb(), []);
  },
}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
// The real package pulls a TurboModule spec that jest cannot parse; only the
// row wrapper is used here.
jest.mock('react-native-gesture-handler', () => {
  const R = require('react');
  const {View} = require('react-native');
  const Swipeable = R.forwardRef((p: {children?: unknown}, ref: unknown) =>
    R.createElement(View, {ref}, p.children));
  return {Swipeable, GestureHandlerRootView: 'GestureHandlerRootView'};
});
jest.mock('expo-linear-gradient', () => ({LinearGradient: 'LinearGradient'}));
jest.mock('@components/ui/ImageryBackdrop', () => ({__esModule: true, default: () => null}));
jest.mock('@/modules/messenger/ui/AmbientBg', () => ({AmbientBg: 'AmbientBg'}));
jest.mock('@/modules/messenger/ui/SponsoredSlot', () => ({SponsoredSlot: () => null}));
jest.mock('@/modules/messenger/ui/ConnectionBanner', () => ({ConnectionBanner: () => null}));
jest.mock('@/modules/messenger/ui/AvatarViewer', () => ({AvatarViewer: () => null}));
// The avatars reach react-native-fs through the media module, which jest cannot
// parse; none of them is what this file is about.
jest.mock('@/modules/messenger/ui/UserAvatar', () => ({UserAvatar: () => null, useUserAvatar: () => null}));
jest.mock('@/modules/messenger/ui/GroupAvatar', () => ({GroupAvatar: () => null, useGroupAvatarUri: () => null}));
jest.mock('@/modules/messenger/ui/OnlineDot', () => ({OnlineDot: () => null}));
jest.mock('@components/NotificationPermissionBanner', () => ({__esModule: true, default: () => null}));
jest.mock('@components/NotificationReliabilityCard', () => ({__esModule: true, default: () => null}));
jest.mock('@components/ProfileDrawerModal', () => ({ProfileDrawerModal: () => null}));
jest.mock('../RestoreActivityBanner', () => ({__esModule: true, default: () => null}));
// The two INLINE tab bodies. Neither is on the Chats tab this file exercises,
// but both are imported at module scope and drag half the app with them.
jest.mock('../CallsLogScreen', () => ({CallsLogBody: () => null}));
jest.mock('@screens/news/NewsHubScreen', () => ({NewsHubBody: () => null}));
jest.mock('@services/api', () => ({
  conversationApi: {mine: jest.fn().mockRejectedValue(new Error('offline'))},
  departmentApi: {listChannels: jest.fn().mockRejectedValue(new Error('offline'))},
  tokenStore: {get: () => null},
  refreshAccessTokenShared: jest.fn(),
}));
jest.mock('@bravo/messenger-core', () => ({UsersHttpClient: class {}}));
jest.mock('@/modules/messenger/contacts/useDiscoveredContacts', () => ({useDiscoveredContacts: () => undefined}));
jest.mock('@/modules/messenger/contacts/useRegisteredNames', () => ({useRegisteredNames: () => undefined}));
jest.mock('@/modules/messenger/orgWorkspace/conversationIntents', () => ({
  drainConversationIntents: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/modules/messenger/orgWorkspace/dispatchRoomIntents', () => ({
  drainDispatchRoomIntents: jest.fn().mockResolvedValue(undefined), isOpsRoomKeyAuthority: () => false,
}));
jest.mock('@/modules/messenger/runtime/pendingRosterIntents', () => ({
  flushRosterIntents: jest.fn().mockResolvedValue(undefined),
  hasPendingRosterIntent: () => false, resolveRosterOverwrite: jest.fn(),
}));
jest.mock('@/modules/messenger/backup/conversationTombstones', () => ({clearConversationTombstone: jest.fn()}));
jest.mock('@hooks/useDeptChatV2', () => ({useDeptChatV2: () => false}));
jest.mock('../useDeptConversationFilter', () => ({useIsDeptConversation: () => () => false}));
jest.mock('@store/authStore', () => ({
  useAuthStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({user: {id: 'me', full_name: 'Me'}}),
    {getState: () => ({user: {id: 'me', full_name: 'Me'}})}),
}));
jest.mock('@store/productStore', () => ({
  useProductStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({activeProduct: 'messenger'}),
    {getState: () => ({activeProduct: 'messenger'})}),
}));
jest.mock('@store/entitlements', () => ({
  useEntitlements: () => ({hasDeptChannels: false, isOrgAffiliated: false, tier: 'pro'}),
  deriveEntitlements: () => ({isWorkspaceTenant: false}),
}));
// The REAL runtime lane — this is the mock the whole file turns on.
//
// The returned object is built ONCE. A fresh literal per call changes
// `runtime`'s identity on every render, and `runtime` is a dependency of the
// body-scan effect — so the effect re-runs, its cleanup disowns the in-flight
// read (`alive = false`), and the hits NEVER land. The real hook is stable;
// an unstable double reproduces a bug that does not exist.
jest.mock('@/modules/messenger/hooks', () => {
  const runtime = {
    searchMessages: (...args: unknown[]) => mockSearchMessages(...args),
    subscribePresence: jest.fn(),
    unsubscribePresence: jest.fn(),
  };
  const value = {runtime};
  return {useMessenger: () => value};
});
jest.mock('@/modules/messenger/store', () => {
  // Read LAZILY. A jest.mock factory runs when the module is first required —
  // which the hoisted `import MessengerHomeScreen` below makes earlier than the
  // `const mockState` assignment, so capturing it here would freeze `undefined`.
  const hook = (sel: (s: unknown) => unknown) => sel(mockState);
  return {
    useMessengerStore: Object.assign(hook, {
      getState: () => mockState,
      persist: {hasHydrated: () => true, onFinishHydration: () => () => undefined},
    }),
  };
});

import MessengerHomeScreen from '../MessengerHomeScreen';

const SEARCH = 'Search secure messages…';

const row = (over: Record<string, unknown>) => ({
  conversation_id: 'c-alice', sender_id: 'u-alice', content: '',
  created_at: '2026-09-10T09:00:00.000Z', ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchMessages.mockResolvedValue([]);
});

describe('A1 — the chat list searches on TWO lanes, and the union is the answer', () => {
  it('asks SQL only for the conversations this list shows (the scope boundary)', async () => {
    const u = render(<MessengerHomeScreen />);
    fireEvent.changeText(await u.findByPlaceholderText(SEARCH), 'contract');
    await waitFor(() => expect(mockSearchMessages).toHaveBeenCalled());
    const [term, opts] = mockSearchMessages.mock.calls[0] as [string, {conversationIds: string[]}];
    expect(term).toBe('contract');
    expect([...opts.conversationIds].sort()).toEqual(['c-alice', 'c-bob']);
  });

  it('THE UNION: a chat whose NAME does not match still shows when the body lane hit it', async () => {
    // Neither "Alice" nor her last message contains "contract", and the
    // in-memory lane only sees the last 30 hydrated rows anyway — this row
    // exists only in SQL. Dropping the `|| bodyHitIds.has(c.id)` arm takes
    // full-history search away, and nothing else in the suite would notice.
    mockSearchMessages.mockResolvedValue([row({id: 'm1', type: 'text', content: 'the contract is signed'})]);
    const u = render(<MessengerHomeScreen />);
    fireEvent.changeText(await u.findByPlaceholderText(SEARCH), 'contract');
    // Wait on the HIT ROW, not on a name: between the 150 ms debounce and the
    // SQL answer there is a window where the name lane has already filtered
    // both chats out, and either name assertion would read that window as its
    // own result. The hit row exists only once lane 2 has landed.
    await u.findByTestId('channel-msg-hit-m1');
    // "Results · N" IS `filtered.length`, so this is the union itself: exactly
    // one conversation survived, and it survived on the body lane alone.
    expect(u.getByText('Results · 1')).toBeTruthy();
    // Alice's name matches nothing; she is on the list, and Bob is not.
    expect(u.queryAllByText('Alice').length).toBeGreaterThan(0);
    expect(u.queryByText('Bob')).toBeNull();
    expect(u.queryByText('No matches')).toBeNull();
  });

  it('a query that matches nothing on either lane leaves the list empty', async () => {
    const u = render(<MessengerHomeScreen />);
    fireEvent.changeText(await u.findByPlaceholderText(SEARCH), 'contract');
    await waitFor(() => expect(u.getByText('No matches')).toBeTruthy());
  });

  it('does not scan bodies for a single character', async () => {
    const u = render(<MessengerHomeScreen />);
    fireEvent.changeText(await u.findByPlaceholderText(SEARCH), 'a');
    // The name lane still answers — Alice matches "a".
    await waitFor(() => expect(u.getByText('Alice')).toBeTruthy());
    expect(mockSearchMessages).not.toHaveBeenCalled();
  });
});

describe('B-838 — a media hit reaches the chat list as a document', () => {
  it('renders the FILE NAME of a PDF found by name, with the document glyph', async () => {
    // The caption is empty, which is the normal case for a document — the old
    // single-source snippet rule discarded exactly this row.
    mockSearchMessages.mockResolvedValue([row({
      id: 'm-pdf', type: 'file', media_mime: 'application/pdf',
      media_meta: {name: 'Contract-Q3.pdf'},
    })]);
    const u = render(<MessengerHomeScreen />);
    fireEvent.changeText(await u.findByPlaceholderText(SEARCH), 'contract');
    await u.findByTestId('channel-msg-hit-m-pdf');
    expect(u.getByTestId('msg-hit-name-m-pdf').props.children).toBe('Contract-Q3.pdf');
    expect(u.getByTestId('msg-hit-icon-m-pdf').props.name).toBe('file-pdf-box');
  });

  it('renders a photo hit with the sender thumbnail, matched on its caption', async () => {
    mockSearchMessages.mockResolvedValue([row({
      id: 'm-img', type: 'image', content: 'the site plan as built',
      media_mime: 'image/jpeg', media_meta: {name: 'IMG_20260910.jpg', thumbB64: 'QUJD'},
    })]);
    const u = render(<MessengerHomeScreen />);
    fireEvent.changeText(await u.findByPlaceholderText(SEARCH), 'site plan');
    await u.findByTestId('channel-msg-hit-m-img');
    expect(u.getByTestId('msg-hit-thumb-m-img').props.source.uri)
      .toBe('data:image/jpeg;base64,QUJD');
  });

  it('STILL drops a hit whose conversation is not in this list', async () => {
    // The B-636 second belt, on the chat list too: the ref map is built from
    // `ordered`, so a leaked row cannot render even though SQL returned it.
    mockSearchMessages.mockResolvedValue([
      row({id: 'mine', conversation_id: 'c-alice', type: 'file', media_mime: 'application/pdf',
        media_meta: {name: 'Contract-Q3.pdf'}}),
      row({id: 'foreign', conversation_id: 'c-not-listed', type: 'file', media_mime: 'application/pdf',
        media_meta: {name: 'Contract-Q3.pdf'}}),
    ]);
    const u = render(<MessengerHomeScreen />);
    fireEvent.changeText(await u.findByPlaceholderText(SEARCH), 'contract');
    await u.findByTestId('channel-msg-hit-mine');
    expect(u.queryByTestId('channel-msg-hit-foreign')).toBeNull();
  });
});
