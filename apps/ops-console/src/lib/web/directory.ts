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
  const batched = profileBatcher(async ids => {
    const {profiles} = await webApi.profiles(ids);
    const out = new Map<string, ChatPerson>();
    for (const p of profiles) {
      if (!p.displayName) continue;
      const person = {id: p.userId, name: p.displayName, subtitle: 'Bravo Secure'};
      people.set(p.userId, person);
      out.set(p.userId, person);
    }
    return out;
  });
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
    // 2026-10-25 — one POST /users/profiles per chat row hit the server's
    // 60-per-10-minutes limit on a full chat list, and every row past it
    // showed "Bravo user". Lookups made in the same moment now share ONE
    // request (up to 100 ids), and a missing name stays empty so the caller
    // can show the phone number instead.
    get: id => {
      const known = people.get(id);
      if (known) return Promise.resolve(known);
      return batched(id);
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

/**
 * Collects lookups made within `windowMs` into one request of up to `max` ids.
 * Each caller gets its own person, or null when the server has no name for it.
 */
export function profileBatcher(
  fetchMany: (ids: string[]) => Promise<Map<string, ChatPerson>>,
  opts: {windowMs?: number; max?: number} = {},
): (id: string) => Promise<ChatPerson | null> {
  const windowMs = opts.windowMs ?? 40;
  const max = opts.max ?? 100;
  let queue = new Map<string, Array<{resolve: (p: ChatPerson | null) => void; reject: (e: unknown) => void}>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = async (): Promise<void> => {
    timer = null;
    const batch = queue;
    queue = new Map();
    const ids = [...batch.keys()];
    for (let i = 0; i < ids.length; i += max) {
      const chunk = ids.slice(i, i + max);
      try {
        const found = await fetchMany(chunk);
        for (const id of chunk) for (const w of batch.get(id) ?? []) w.resolve(found.get(id) ?? null);
      } catch (e) {
        for (const id of chunk) for (const w of batch.get(id) ?? []) w.reject(e);
      }
    }
  };
  return id => new Promise((resolve, reject) => {
    const waiters = queue.get(id) ?? [];
    waiters.push({resolve, reject});
    queue.set(id, waiters);
    if (!timer) timer = setTimeout(() => { void flush(); }, windowMs);
  });
}
