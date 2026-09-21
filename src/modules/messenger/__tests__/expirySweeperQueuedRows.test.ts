/**
 * PG-M6 — the disappearing-message sweeper must not burn a row that is still
 * QUEUED.
 *
 * The sender stamps `expires_at` at compose, so a disappearing message written
 * offline reached its TTL with a live outbox row: the sweeper removed the
 * bubble (no retry chip could ever show), the drain later shipped it, and the
 * recipient's expiredEnvelopeGate dropped it — neither side ever saw it. The
 * timer is honoured from `sent` onward; the outbox owns a `sending` row.
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

import {ExpirySweeper} from '../runtime/expirySweeper';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalConversation, LocalMessage} from '../store/types';

const NOW = 1_800_000_000_000;

function seed(status: LocalMessage['status']): void {
  const s = useMessengerStore.getState();
  s.reset();
  s.setOwner('me');
  s.upsertConversation({
    id: 'c1', type: 'direct', participants: ['bob'], unread_count: 0, is_muted: false,
    created_at: new Date(NOW - 60_000).toISOString(), peer: {userId: 'bob', deviceId: 1},
    session_state: 'established',
  } as LocalConversation);
  s.appendMessage('c1', {
    id: 'm-ttl', conversation_id: 'c1', sender_id: 'self', type: 'text', content: 'burn',
    status, is_encrypted: true, created_at: new Date(NOW - 30_000).toISOString(),
    peer: {userId: 'bob', deviceId: 1}, expires_at: NOW - 1_000,
  });
}

describe('PG-M6 — ExpirySweeper and queued rows', () => {
  it('leaves a past-due `sending` row alone', () => {
    seed('sending');
    const sweeper = new ExpirySweeper();
    expect(sweeper.sweep(NOW)).toBe(0);
    expect(useMessengerStore.getState().messages.c1.map(m => m.id)).toEqual(['m-ttl']);
  });

  it('burns it the moment it is at least `sent`', () => {
    seed('sending');
    const sweeper = new ExpirySweeper();
    sweeper.sweep(NOW);
    useMessengerStore.getState().updateMessageStatus('c1', 'm-ttl', 'sent');
    expect(sweeper.sweep(NOW + 1)).toBe(1);
    expect(useMessengerStore.getState().messages.c1 ?? []).toHaveLength(0);
  });

  it('a past-due delivered / read row still burns (the timer is unchanged for shipped rows)', () => {
    for (const status of ['sent', 'delivered', 'read'] as const) {
      seed(status);
      expect(new ExpirySweeper().sweep(NOW)).toBe(1);
    }
  });
});
