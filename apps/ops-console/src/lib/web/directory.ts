/**
 * Who the web app's Messenger can find (2026-10-03).
 *
 * Privacy first, like the app's "contacts on Bravo": there is no name search
 * over every Bravo account. A person is found only by their exact phone number
 * (POST /users/lookup, which answers matches only and is throttled server-side),
 * and a chat that already exists shows the peer's public name and avatar
 * (POST /users/profiles). Blocked users never appear either way.
 */
import type {ChatDirectory, ChatPerson} from '@/features/messenger/ChatWorkspace';
import {webApi} from './api';
import {toE164} from './phone';

export {toE164};

export function webChatDirectory(userId: string): ChatDirectory {
  const people = new Map<string, ChatPerson>();
  const looked = new Map<string, ChatPerson[]>();
  return {
    search: async q => {
      const phone = toE164(q);
      if (!phone) return [];
      const hit = looked.get(phone);
      if (hit) return hit;
      const {matches} = await webApi.lookupPhones([phone]);
      const out = matches.map(m => ({id: m.userId, name: m.displayName || m.phone, subtitle: m.phone}));
      for (const p of out) people.set(p.id, p);
      looked.set(phone, out);
      return out;
    },
    get: async id => {
      const known = people.get(id);
      if (known) return known;
      const {profiles} = await webApi.profiles([id]);
      const p = profiles[0];
      if (!p) return null;
      const person = {id: p.userId, name: p.displayName || 'Bravo user', subtitle: 'Bravo Secure'};
      people.set(id, person);
      return person;
    },
    searchPlaceholder: 'New chat: enter a phone number with country code (+971…)',
    searchError: e => ((e as {status?: number})?.status === 429
      ? 'Too many number searches. Wait a few minutes and try again.'
      : 'Search failed. Try again.'),
    noResultsText: q => (toE164(q)
      ? 'No Bravo Secure account uses this number, or it is not available to you.'
      : 'Type the full number with its country code, for example +971 50 123 4567.'),
    emptyText: 'No chats yet. Start one with a phone number above. Chats from the Bravo app arrive here once this browser is set up; earlier messages stay on your phone.',
    // Per account: a second person signing in on this browser starts unread-clean.
    seenKey: `bravo_web_chat_seen_v1:${userId}`,
    title: 'Chats',
  };
}
