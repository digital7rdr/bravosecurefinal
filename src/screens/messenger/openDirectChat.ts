/**
 * The ONE door from a PERSON row (a channel member, a roster entry) into that
 * person's 1:1 messenger thread.
 *
 * ── WHY IT IS NOT `openConversation` ────────────────────────────────────────
 *
 * `openConversation` takes a conversation id — it answers "which surface does
 * THIS thread open on". A person row has no conversation id: a peer you have
 * never messaged has no row in the store at all, and a peer you have may hold
 * either the synthetic `direct:<peer>` key or a server-issued UUID row. Picking
 * the wrong one is the split-brain bug `resolveDirectConversationIdFromState`
 * exists to prevent (BS-NC1): the tap opens an empty synthetic thread while the
 * history and every new inbound land on the UUID row.
 *
 * ── WHY IT NAVIGATES CROSS-SHELL ────────────────────────────────────────────
 *
 * `openConversation`'s ordinary arm keeps a bare `navigate('Chat', …)` because
 * every screen that calls it is mounted beside `Chat`. The member list is NOT:
 * `ChannelMembersScreen` is dual-mounted on `MessengerNavigator` (where `Chat`
 * is a sibling) AND on `DepartmentalNavigator`'s Channels stack, which registers
 * no `Chat` at all. A bare navigate from the workspace shell is the documented
 * "a screen in 2 shells, a route in 1 -> navigate silently DROPPED" failure, so
 * this goes through `navigateToMessengerScreen` — the same door the notification
 * lane uses — which knows the per-shell path to `Chat`. `initial: false` seeds
 * `MessengerHome` underneath so Back does not bubble out of the stack (B-85).
 */
import {navigateToMessengerScreen} from '@navigation/messengerDeepLink';
import {useMessengerStore, resolveDirectConversationIdFromState} from '@/modules/messenger/store';
import {useAuthStore} from '@store/authStore';
import {markChatOpenTap} from './chatOpenPerf';

export interface DirectChatPeer {
  userId: string;
  /** Directory display name. Falls back to an existing row's name. */
  name?: string | null;
  avatarUrl?: string | null;
  /** Phase-1 peers live on signal deviceId=1. */
  deviceId?: number;
}

/**
 * Open (or create) the 1:1 thread with `peer` and navigate to it.
 *
 * Returns false without navigating when there is no peer to open — an empty id,
 * or the caller's own row. A "message yourself" thread is not a product here,
 * and minting `direct:<me>` would put a self-addressed row in the chat list that
 * no send path can ever deliver to.
 */
export function openDirectChat(nav: unknown, peer: DirectChatPeer): boolean {
  const me = useAuthStore.getState().user?.id;
  if (!peer.userId || peer.userId === me) {return false;}

  const st = useMessengerStore.getState();
  const conversationId = resolveDirectConversationIdFromState(st, peer.userId);
  const existing = st.conversations[conversationId];
  const name = peer.name?.trim() || existing?.name || 'Member';

  // Seed ONLY when there is no row yet. `upsertConversation` REPLACES the entry
  // (it merges nothing but `rosterUserIds`/`name_source`), so re-seeding a live
  // thread would blank its `last_message` preview and zero its unread count.
  if (!existing) {
    st.upsertConversation({
      id:            conversationId,
      type:          'direct',
      // B-411 — this name comes from the org directory, not the phone address
      // book, so it is 'profile' and a later contact-sync label may win.
      name,
      name_source:   'profile',
      ...(peer.avatarUrl ? {avatar_url: peer.avatarUrl} : {}),
      participants:  [me ?? 'self', peer.userId],
      unread_count:  0,
      is_muted:      false,
      created_at:    new Date().toISOString(),
      peer:          {userId: peer.userId, deviceId: peer.deviceId ?? 1},
      session_state: 'fresh',
    });
  }

  // B-691/F4 — same tap stamp the list rows write, so ChatScreen's [chat.open]
  // bracket reports true tap→transitionEnd from this door too.
  markChatOpenTap(conversationId);
  return navigateToMessengerScreen(
    nav as never,
    'Chat',
    {conversationId, name, isGroup: false},
    {initial: false},
  );
}
