/**
 * One phone number, a new account (2026-10-24).
 *
 * The messenger's local data (chat list, SQLCipher history, Signal sessions,
 * keystore entries) is scoped to the OWNER KEY — the account's email or phone
 * number — not to the account id, so a re-login of the same person keeps their
 * history. But when an account is deleted and the same number registers again,
 * that is a NEW account (new id, new keys on the server) that inherited the
 * dead account's local data:
 *   - its old chats point at the old account ids of the other people (often
 *     deleted too), so calls and messages from them go nowhere;
 *   - their participant lists still name the OLD self id, which the call
 *     launcher counted as "another member" and so rang a 1:1 call as a
 *     group call that nobody could answer ("Calling…", the other phone silent).
 *
 * The guard remembers which account last used an owner key on this phone. When
 * a different account signs in with the same owner key, the previous account's
 * local messenger data is wiped before the messenger starts.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {LocalConversation} from '../store/types';

const MARKER_PREFIX = 'msg:ownerAuth:';

/**
 * Ids that a slice's 1:1 chats name as "me" but that are not `userId` — the
 * signature of another account's data. A 1:1 chat lists at most me + the peer.
 */
export function foreignSelfIds(conversations: Record<string, LocalConversation> | undefined, userId: string): string[] {
  const out = new Set<string>();
  for (const c of Object.values(conversations ?? {})) {
    if (!c || c.type !== 'direct') {continue;}
    const peer = c.peer?.userId;
    for (const p of c.participants ?? []) {
      if (p && p !== 'self' && p !== userId && p !== peer) {out.add(p);}
    }
  }
  return [...out];
}

/** True when this slice holds 1:1 chats of another account and none of `userId`'s. */
export function sliceBelongsToAnotherAccount(conversations: Record<string, LocalConversation> | undefined, userId: string): boolean {
  if (foreignSelfIds(conversations, userId).length === 0) {return false;}
  const mine = Object.values(conversations ?? {}).some(c => c?.type === 'direct' && (c.participants ?? []).includes(userId));
  return !mine;
}

export type GuardVerdict = 'same-account' | 'first-seen' | 'wiped-other-account';

/**
 * Run before the messenger starts for (ownerKey, userId). Wipes the owner
 * key's local messenger data when it belongs to another account, then records
 * `userId` as the owner key's account.
 */
export async function guardOwnerAccount(
  ownerKey: string,
  userId: string,
  deps: {
    slice: () => Record<string, LocalConversation> | undefined;
    wipe: (ownerKey: string) => Promise<unknown>;
    dropInMemory: (ownerKey: string) => void;
  },
): Promise<GuardVerdict> {
  if (!ownerKey || !userId) {return 'same-account';}
  const key = `${MARKER_PREFIX}${ownerKey}`;
  let previous: string | null = null;
  try { previous = await AsyncStorage.getItem(key); } catch { /* storage blip: decide from the data */ }

  let other = false;
  if (previous) {other = previous !== userId;}
  else {other = sliceBelongsToAnotherAccount(deps.slice(), userId);}

  if (other) {
    console.warn('[owner-guard] a different account now uses this number on this phone — clearing the previous account\'s local messenger data');
    try { await deps.wipe(ownerKey); } catch (e) { console.warn('[owner-guard] wipe failed:', (e as Error).message); }
    try { deps.dropInMemory(ownerKey); } catch { /* best effort */ }
  }
  try { await AsyncStorage.setItem(key, userId); } catch { /* retried next boot */ }
  if (other) {return 'wiped-other-account';}
  return previous ? 'same-account' : 'first-seen';
}
