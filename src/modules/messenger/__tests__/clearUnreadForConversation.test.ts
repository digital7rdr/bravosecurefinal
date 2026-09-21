/**
 * B-711 — "Mark as read" from the notification leaves the unread count behind.
 *
 * markRead flips message status and emits the read receipt (the sender gets
 * ✓✓), but only `setActiveConversation` zeroed `unread_count` — so the
 * chat-list pill, the tab count and the launcher badge all survived a read the
 * sender already saw as done, and the NEXT banner re-asserted a badge for a
 * conversation the user had read from the shade.
 *
 * The fix is a dedicated store action, called from the notification
 * pending-action drain (NOT from inside productionRuntime.markRead — that is a
 * MESSAGE_LOOP trigger file and this lane is the one that needs the clear).
 * Half of the pin is the store behaviour (executed); the other half is a
 * source scan of the drain wiring, because fcmBootstrap cannot be imported by
 * this Jest project.
 */
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear:      async () => { store.clear(); },
    },
  };
});

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalConversation} from '../store/types';

const CONV  = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PEER  = 'alice-uuid';

const convo = (id: string, over: Partial<LocalConversation> = {}): LocalConversation => ({
  id, type: 'direct', name: id, participants: [], peer: {userId: PEER, deviceId: 1},
  session_state: 'established', unread_count: 0, is_muted: false,
  created_at: '2026-05-25T11:00:00.000Z', ...over,
} as LocalConversation);

describe('B-711 — clearUnreadForConversation', () => {
  beforeEach(() => {
    useMessengerStore.setState({
      activeConversationId: null,
      conversations: {
        [CONV]:          convo(CONV,  {unread_count: 3}),
        // L20 sibling slot for the same peer — the badge lives on BOTH.
        [`direct:${PEER}`]: convo(`direct:${PEER}`, {unread_count: 3}),
        [OTHER]:         convo(OTHER, {unread_count: 5, peer: {userId: 'bob-uuid', deviceId: 1}}),
      },
    } as never);
  });

  it('zeroes the conversation AND its direct sibling slots, without opening it', () => {
    useMessengerStore.getState().clearUnreadForConversation(CONV);
    const s = useMessengerStore.getState();
    expect(s.conversations[CONV]?.unread_count).toBe(0);
    expect(s.conversations[`direct:${PEER}`]?.unread_count).toBe(0);
    // The action must not act like setActiveConversation.
    expect(s.activeConversationId).toBeNull();
    // Unrelated conversations keep their count.
    expect(s.conversations[OTHER]?.unread_count).toBe(5);
  });

  it('is a safe no-op for an unknown conversation id', () => {
    expect(() =>
      useMessengerStore.getState().clearUnreadForConversation('33333333-3333-4333-8333-333333333333'),
    ).not.toThrow();
    expect(useMessengerStore.getState().conversations[OTHER]?.unread_count).toBe(5);
  });

  it('the notification pending-action drain WIRES the clear (source pin)', () => {
    // fcmBootstrap mounts RN modules, so this half is a source scan. CRLF-safe,
    // comments stripped so prose can never satisfy it (repo scanner rules).
    const src = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts'), 'utf8',
    ).replace(/\r\n/g, '\n').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // Both drain branches that mark a conversation read must also clear the badge.
    const readBranch = src.match(/e\.t === 'read'[\s\S]{0,400}?clearUnreadBadge\(e\.convId\)/);
    expect(readBranch).not.toBeNull();
    const replyBranch = src.match(/stableMsgId: `notifreply-\$\{e\.id\}`[\s\S]{0,200}?clearUnreadBadge\(e\.convId\)/);
    expect(replyBranch).not.toBeNull();
    // And the helper reaches the store action, not a copy of its logic.
    expect(src).toMatch(/clearUnreadForConversation\(convId\)/);
  });
});
