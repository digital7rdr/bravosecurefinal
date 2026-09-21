/**
 * Founder 2026-09-01 — tapping a person row (channel Members list) opens that
 * person's 1:1 thread.
 *
 * Four things can go wrong here and none of them is visible in a render test:
 *
 *  1. Minting `direct:<peer>` when a server-UUID row already exists — the
 *     BS-NC1 split-brain: the tap opens an EMPTY thread while the history and
 *     every new inbound land on the UUID row.
 *  2. Re-seeding a row that already exists. `upsertConversation` REPLACES the
 *     entry, so a re-seed blanks `last_message` (the chat-list preview) and
 *     zeroes `unread_count`.
 *  3. Bare-navigating to 'Chat'. The Members screen is ALSO mounted on
 *     `DepartmentalNavigator`'s Channels stack, which registers no `Chat` —
 *     the documented "screen in 2 shells, route in 1 -> silently DROPPED".
 *  4. Opening a thread with YOURSELF. `direct:<me>` is a row the chat list
 *     renders and no send path can deliver to.
 */
const mockNavigateToMessengerScreen = jest.fn((..._a: unknown[]) => true);
const mockUpsert = jest.fn();
const mockMarkTap = jest.fn();

let mockStoreState: {conversations: Record<string, unknown>; upsertConversation: typeof mockUpsert};
let mockAuthUserId: string | undefined = 'me-1';

jest.mock('@navigation/messengerDeepLink', () => ({
  navigateToMessengerScreen: (...a: unknown[]) => mockNavigateToMessengerScreen(...a),
}));
jest.mock('@/modules/messenger/store', () => ({
  useMessengerStore: {getState: () => mockStoreState},
  resolveDirectConversationIdFromState: jest.requireActual(
    '@/modules/messenger/store/messengerStore',
  ).resolveDirectConversationIdFromState,
}));
jest.mock('@store/authStore', () => ({
  useAuthStore: {getState: () => ({user: mockAuthUserId ? {id: mockAuthUserId} : undefined})},
}));
jest.mock('../chatOpenPerf', () => ({markChatOpenTap: (...a: unknown[]) => mockMarkTap(...a)}));

import {openDirectChat} from '../openDirectChat';

const nav = {navigate: jest.fn()};

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthUserId = 'me-1';
  mockStoreState = {conversations: {}, upsertConversation: mockUpsert};
});

describe('openDirectChat', () => {
  it('seeds a cold peer and opens the synthetic thread', () => {
    expect(openDirectChat(nav, {userId: 'u-9', name: 'Baine Kriel'})).toBe(true);

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const seeded = mockUpsert.mock.calls[0][0] as Record<string, unknown>;
    expect(seeded.id).toBe('direct:u-9');
    expect(seeded.type).toBe('direct');
    expect(seeded.name).toBe('Baine Kriel');
    // Directory name, not an address-book label.
    expect(seeded.name_source).toBe('profile');
    expect(seeded.peer).toEqual({userId: 'u-9', deviceId: 1});
    expect(seeded.participants).toEqual(['me-1', 'u-9']);

    expect(mockMarkTap).toHaveBeenCalledWith('direct:u-9');
    expect(mockNavigateToMessengerScreen).toHaveBeenCalledWith(
      nav, 'Chat',
      {conversationId: 'direct:u-9', name: 'Baine Kriel', isGroup: false},
      {initial: false},
    );
  });

  it('BS-NC1 — reuses the server-UUID row instead of minting a duplicate', () => {
    mockStoreState.conversations = {
      'uuid-abc': {id: 'uuid-abc', type: 'direct', peer: {userId: 'u-9'}, name: 'Baine'},
    };

    openDirectChat(nav, {userId: 'u-9', name: 'Baine Kriel'});

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockNavigateToMessengerScreen).toHaveBeenCalledWith(
      nav, 'Chat',
      {conversationId: 'uuid-abc', name: 'Baine Kriel', isGroup: false},
      {initial: false},
    );
  });

  it('never re-seeds a live synthetic row (upsert REPLACES — it would blank the preview)', () => {
    mockStoreState.conversations = {
      'direct:u-9': {id: 'direct:u-9', type: 'direct', peer: {userId: 'u-9'}, name: 'Baine'},
    };

    openDirectChat(nav, {userId: 'u-9', name: 'Baine Kriel'});

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockNavigateToMessengerScreen).toHaveBeenCalled();
  });

  it('refuses to open a thread with yourself, and navigates nowhere', () => {
    expect(openDirectChat(nav, {userId: 'me-1', name: 'Ranger Danger'})).toBe(false);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockNavigateToMessengerScreen).not.toHaveBeenCalled();
  });

  it('refuses an empty peer id', () => {
    expect(openDirectChat(nav, {userId: '', name: 'nobody'})).toBe(false);
    expect(mockNavigateToMessengerScreen).not.toHaveBeenCalled();
  });

  it('falls back to the stored name, then to a placeholder, when the row has none', () => {
    mockStoreState.conversations = {
      'uuid-abc': {id: 'uuid-abc', type: 'direct', peer: {userId: 'u-9'}, name: 'Stored Name'},
    };
    openDirectChat(nav, {userId: 'u-9', name: '   '});
    expect(mockNavigateToMessengerScreen.mock.calls[0][2]).toMatchObject({name: 'Stored Name'});

    jest.clearAllMocks();
    mockStoreState.conversations = {};
    openDirectChat(nav, {userId: 'u-9', name: null});
    expect(mockNavigateToMessengerScreen.mock.calls[0][2]).toMatchObject({name: 'Member'});
  });
});
