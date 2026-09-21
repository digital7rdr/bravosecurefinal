/**
 * PG-M9 — the `direct:<peer>` → server-UUID re-route in `appendMessage` must
 * honour the same unread rules as the main path (BS-MUTE-UNREAD): a muted
 * server row must not bump its badge, and an own row never does.
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

import {useMessengerStore} from '../store/messengerStore';
import type {LocalConversation, LocalMessage} from '../store/types';

function seed(muted: boolean): void {
  const s = useMessengerStore.getState();
  s.reset();
  s.setOwner('me');
  s.upsertConversation({
    id: 'srv-1', type: 'direct', participants: ['bob'], unread_count: 0, is_muted: muted,
    created_at: '2026-09-01T00:00:00.000Z', peer: {userId: 'bob', deviceId: 1},
    session_state: 'established',
  } as LocalConversation);
}

function inbound(id: string, sender = 'bob'): LocalMessage {
  return {
    id, conversation_id: 'direct:bob', sender_id: sender, type: 'text', content: 'hi',
    status: 'delivered', is_encrypted: true, created_at: '2026-09-02T00:00:00.000Z',
    peer: {userId: 'bob', deviceId: 1},
  };
}

describe('PG-M9 — direct-slot re-route and the unread badge', () => {
  it('re-routes into the server row (memory) and bumps unread when NOT muted', () => {
    seed(false);
    const s = useMessengerStore.getState();
    s.appendMessage('direct:bob', inbound('m1'));
    const st = useMessengerStore.getState();
    expect(st.messages['srv-1']?.map(m => m.id)).toEqual(['m1']);
    expect(st.messages['direct:bob'] ?? []).toHaveLength(0);
    expect(st.conversations['srv-1'].unread_count).toBe(1);
  });

  it('does NOT bump unread on a muted server row', () => {
    seed(true);
    useMessengerStore.getState().appendMessage('direct:bob', inbound('m1'));
    expect(useMessengerStore.getState().conversations['srv-1'].unread_count).toBe(0);
    expect(useMessengerStore.getState().messages['srv-1']?.map(m => m.id)).toEqual(['m1']);
  });
});
