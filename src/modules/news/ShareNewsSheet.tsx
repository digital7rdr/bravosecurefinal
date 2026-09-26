/**
 * Share a news link into a Bravo chat, group, or WORKSPACE CHANNEL.
 *
 * Founder 2026-08-05: every news link — Bravo Intel AND My Feed — should be
 * shareable to internal Bravo contacts and groups, "to encourage a community
 * within the App". Deliberately NOT the OS share sheet: the point is to keep
 * the conversation inside Bravo.
 *
 * Client 2026-08-22: "in the picker it will show the workspace name; if I click
 * the workspace then the threads show up of all from that workspace and I can
 * share any one of them." So the sheet is now TWO LEVELS: chats + workspace rows
 * at the root, that workspace's channels one tap in.
 *
 * ── TWO PICKERS, ON PURPOSE ──────────────────────────────────────────────
 *
 *   • CHATS use `ForwardList` (exported from ChatScreen) — the same conversation
 *     picker the message-forward flow uses. It lists 1:1 chats and groups and
 *     deliberately EXCLUDES department channels, and it must keep doing so
 *     (pinned by `broadcastWriteGate.test.ts`): a channel is an ordinary
 *     `type:'group'` row, `sendText` fans a sealed envelope to every member, and
 *     that picker has no channel id, no roster and no role, so it cannot tell
 *     whether the caller may post. Widening it would reopen F7.
 *
 *   • CHANNELS therefore get their own door, built on the channel DTOs, which DO
 *     carry `my_role`. `shareWorkspaceGroups` marks each row postable before the
 *     UI sees it, and `sendToChannel` re-asserts the role against the server
 *     before it writes — because a disabled row is an affordance, never the
 *     boundary (A4). Same predicate and same freshness move as
 *     `DepartmentChatScreen.send()`: one rule, one shape.
 *
 * The shared link is sent as an ordinary text message. ChatScreen and
 * DepartmentChatScreen both render a URL in a bubble via LinkifiedText +
 * LinkPreviewCard, so a shared story arrives as a tappable link with an OG
 * preview and needs no new message type, no wire change and no schema migration.
 *
 * We send through the runtime directly instead of navigating to the thread.
 * `deptChatNoChatScreenDoor.test.ts` sweeps the repo for `navigate('Chat')`
 * outside an allow-list precisely to stop new doors opening onto ChatScreen,
 * and the user's intent here is "send this", not "go there".
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {View, Text, StyleSheet, Modal, Pressable, ActivityIndicator, TouchableOpacity, Share, Platform, useWindowDimensions} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {ForwardList} from '@screens/messenger/ChatScreen';
import {useMessengerStore} from '@/modules/messenger/store';
import {getMessengerRuntime} from '@/modules/messenger/runtime';
import {useAuthStore} from '@store/authStore';
import {departmentApi} from '@services/api';
import {Alert} from '@utils/alert';
import {buildShareText, type ShareableNews} from './shareNewsText';
import {
  shareWorkspaceGroups, allowShareToChannel,
  type ShareWorkspaceGroup, type ShareChannelTarget,
} from './shareChannelTargets';
import {ShareWorkspaceList, ShareChannelList, resolveOpenGroup} from './ShareChannelPicker';

// Re-exported so screens can import the sheet and its payload type together.
// The builder itself lives in shareNewsText.ts — no RN imports — so it stays
// unit-testable without dragging ChatScreen's native deps into the test.
export type {ShareableNews};

/**
 * B-656 — MEMOISED so a host re-render does not re-run this body while the
 * sheet is closed. Both hosts keep it permanently mounted with `item={null}`.
 *
 * ⚠️ NOT an early `if (!item) return null`. That was proposed and it is a
 * CRASH: the return would sit above six hooks, so the first time `item` went
 * null → object React would see the hook count jump from 0 to 6 and throw
 * "Rendered more hooks than during the previous render". The memo achieves the
 * same saving with none of that risk — and RN's `Modal` already returns null
 * when `visible` is false, so nothing below ever MOUNTS while closed.
 *
 * For this memo to bail, the host must pass a stable `onClose`.
 */
export const ShareNewsSheet = React.memo(function ShareNewsSheet({item, onClose}: {item: ShareableNews | null; onClose: () => void}) {
  const [sending, setSending] = useState(false);
  // The interlock is a REF, not the state above: two taps in the same frame both
  // read the pre-render `false` and both send. State still drives the spinner.
  const sendingRef = useRef(false);
  const myId = useAuthStore(s => s.user?.id);

  // B-797 — client 2026-09-04 (relayed by the founder): the OS share sheet is
  // BACK as a second door beside the internal contacts / channels — WhatsApp,
  // Messages, mail, any app on the phone. Same text the internal send uses, so
  // a link shared outside reads exactly like one shared inside. A REF, not
  // state: two taps in one frame would open two native sheets.
  const externalRef = useRef(false);
  const shareOutside = useCallback(async () => {
    if (!item || externalRef.current) {return;}
    externalRef.current = true;
    try {
      const message = buildShareText(item);
      await Share.share(
        Platform.OS === 'ios' ? {message, url: item.url, title: item.title} : {message, title: item.title},
        {dialogTitle: item.title, subject: item.title},
      );
      onClose();
    } catch (e: unknown) {
      Alert.alert('Could not share', (e as Error)?.message || 'No app on this phone could take the link.');
    } finally {
      externalRef.current = false;
    }
  }, [item, onClose]);

  // Workspace channels. Loaded when the sheet opens: the channel list is a
  // network call and the roles on it are what make this door safe, so it is not
  // worth caching stale across opens.
  const [groups, setGroups] = useState<ShareWorkspaceGroup[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  /** Which workspace the user has drilled into; null = the root view. */
  // B-815 — the sheet is the bottom-most element of this surface, so IT pads
  // by `bottomPad` (keyboard when up, nav bar when not). With the IME up its
  // height is bounded by the space ABOVE the keyboard: the earlier
  // `marginBottom: overlap` lift alone kept the 72% cap, so the sheet ran off
  // the TOP of the screen and the contacts stayed under the keyboard anyway.
  const {overlap, bottomPad} = useKeyboardLayout();
  const {height: winH} = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);

  const open = !!item;
  useEffect(() => {
    if (!open) {
      // Reset on close so the next share starts at the root with fresh roles.
      // Belt-and-braces only: `resolveOpenGroup` already refuses an id that is
      // not in the live list, so a leftover id cannot render stale channels.
      setGroups([]);
      setOpenGroupId(null);
      return;
    }
    let cancelled = false;
    setLoadingGroups(true);
    void (async () => {
      try {
        const {data} = await departmentApi.listChannels();
        if (cancelled) {return;}
        setGroups(shareWorkspaceGroups(data.channels ?? []));
      } catch {
        // Best-effort: a member with no workspace, an old server, or no network
        // simply gets the chats section. Never an error banner over a share.
        if (!cancelled) {setGroups([]);}
      } finally {
        if (!cancelled) {setLoadingGroups(false);}
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const finish = useCallback((title: string, body: string) => {
    onClose();
    Alert.alert(title, body);
  }, [onClose]);

  const send = async (conversationId: string) => {
    if (!item || sendingRef.current) {return;}
    sendingRef.current = true;
    setSending(true);
    try {
      const target = useMessengerStore.getState().conversations[conversationId];
      if (!target) {throw new Error('Conversation not found.');}
      const rt = await getMessengerRuntime('production');
      // `peer` mirrors what ChatScreen's forwardTo passes; isGroup is derived by
      // the runtime from the conversation, so we deliberately do not guess it.
      await rt.sendText(conversationId, buildShareText(item), {peer: target.peer});
      finish('Shared', `Sent to ${target.name ?? 'the conversation'}.`);
    } catch (e) {
      finish('Could not share', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const sendToChannel = useCallback(async (t: ShareChannelTarget) => {
    if (!item || sendingRef.current || !t.postable || !t.groupConversationId) {return;}
    sendingRef.current = true;
    setSending(true);
    try {
      /**
       * RE-ASSERT THE ROLE AT THE WRITE, not just in the list.
       *
       * The picker's `postable` came from `listChannels` when the sheet opened;
       * a role can be revoked between then and this tap, and A4 says a control
       * being disabled is never the boundary. The DECISION is
       * `allowShareToChannel` — pure, and unit-tested by behaviour, because an
       * ordering scan cannot see whether the server's answer is obeyed.
       *
       * A 4xx IS AN ANSWER. `listMembers` 403s for a non-member, so treating
       * every throw as "offline" would let someone removed from the channel
       * seconds ago post anyway. Only a transport failure falls back to the
       * cached role — which is what `DepartmentChatScreen.send()` does too, and
       * this is the stricter half of that behaviour.
       */
      let server: {my_role?: string} | null = null;
      try {
        const {data} = await departmentApi.listMembers(t.channelId);
        server = data;
        // The roster is server-authoritative and the local row goes stale (a
        // member who joined after this device last opened the channel is absent
        // from `participants`, and the fan-out reads THAT). DepartmentChatScreen
        // upserts it before every post for exactly this reason; without it the
        // share silently misses the newest members and still says "Shared".
        const memberIds = (data.members ?? []).map(m => m.user_id).filter(Boolean);
        if (memberIds.length > 0) {
          const st = useMessengerStore.getState();
          const existing = st.conversations[t.groupConversationId];
          st.upsertConversation({
            ...(existing ?? {
              unread_count: 0, is_muted: false, created_at: new Date().toISOString(),
              peer: {userId: memberIds.find(id => id !== myId) ?? memberIds[0], deviceId: 1},
              session_state: 'fresh',
            }),
            id: t.groupConversationId,
            type: 'group',
            name: existing?.name ?? t.name,
            participants: memberIds,
          });
        }
      } catch (e) {
        const status = (e as {response?: {status?: number}})?.response?.status;
        if (typeof status === 'number' && status >= 400 && status < 500) {
          finish('Read-only', 'You no longer have permission to post in this channel.');
          return;
        }
        // Transport failure — `server` stays null and the cached role stands in.
      }
      if (!allowShareToChannel({cachedPostable: t.postable, server})) {
        finish('Read-only', 'You no longer have permission to post in this channel.');
        return;
      }
      const stored = useMessengerStore.getState().conversations[t.groupConversationId]?.peer;
      // The runtime ignores this peer for a real group fan-out (it fans to every
      // participant) and only needs `.userId` truthy — the same placeholder
      // DepartmentChatScreen passes.
      const peer = stored ?? (myId ? {userId: myId, deviceId: 1} : undefined);
      const rt = await getMessengerRuntime('production');
      await rt.sendText(t.groupConversationId, buildShareText(item), {peer, isGroup: true});
      finish('Shared', `Sent to ${t.name}.`);
    } catch (e) {
      // Surface the REAL failure (e.g. the channel's group key has not reached
      // this device yet — the runtime raises GROUP_KEY_PENDING_SEND_ERROR and
      // kicks its own re-share request) rather than a generic message.
      finish('Could not share', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [item, myId, finish]);

  const openGroup = resolveOpenGroup(groups, openGroupId);

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="Close share sheet">
        <Pressable
          style={[
            s.sheet,
            {paddingBottom: bottomPad(24)},
            overlap > 0 && {maxHeight: winH - insets.top - 12},
          ]}
          onPress={e => e.stopPropagation()}>
          <View style={s.grabber} />

          {openGroup ? (
            <TouchableOpacity
              style={s.backRow}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Back to all share targets"
              onPress={() => setOpenGroupId(null)}>
              <Icon name="chevron-left" size={20} color="#1E88FF" />
              <Text style={s.backText} numberOfLines={1}>{openGroup.name}</Text>
            </TouchableOpacity>
          ) : (
            <>
              <Text style={s.title}>Share to…</Text>
              <Text style={s.sub} numberOfLines={2}>{item?.title ?? ''}</Text>
            </>
          )}

          {sending ? (
            <View style={s.sending}><ActivityIndicator color="#1E88FF" /></View>
          ) : openGroup ? (
            <ShareChannelList group={openGroup} onPickChannel={t => { void sendToChannel(t); }} />
          ) : (
            /**
             * ONE scroll surface. `ForwardList` owns the FlatList; the
             * outside-share row and the workspace list ride inside it as the
             * list HEADER (B-815) — not a ScrollView around both (nested
             * scrolling is OFF on Android, so the inner list would be clipped),
             * and not a fixed block above it (with the keyboard up that block
             * ate the whole bounded sheet and no contact was reachable). The
             * search box stays pinned at the top; the header hides while a
             * query is active so matches land right under it.
             *
             * No "CHATS" header — `ForwardList` emits its own INDIVIDUALS and
             * GROUPS sections (client 2026-08-22 asked for the three:
             * workspace, individual, group). currentConvId '' — nothing to
             * exclude; we are not inside a chat.
             */
            <ForwardList currentConvId="" onPick={id => { void send(id); }}
              listMaxHeight={null}
              header={(
                <>
                  <TouchableOpacity
                    style={s.outsideRow}
                    activeOpacity={0.75}
                    accessibilityRole="button"
                    accessibilityLabel="Share outside Bravo"
                    onPress={() => { void shareOutside(); }}>
                    <View style={s.outsideIcon}><Icon name="share-variant" size={18} color="#1E88FF" /></View>
                    <View style={{flex: 1, minWidth: 0}}>
                      <Text style={s.outsideTitle}>Share outside Bravo</Text>
                      <Text style={s.outsideSub} numberOfLines={1}>WhatsApp, Messages, email — any app on this phone</Text>
                    </View>
                    <Icon name="chevron-right" size={18} color="rgba(180,188,204,0.45)" />
                  </TouchableOpacity>
                  <ShareWorkspaceList
                    groups={groups}
                    loading={loadingGroups}
                    onOpenGroup={id => setOpenGroupId(id)}
                  />
                </>
              )}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
});

const s = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end'},
  sheet: {backgroundColor: '#122747', borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 10, maxHeight: '72%'},
  grabber: {alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)', marginBottom: 10},
  title: {color: '#FFFFFF', fontSize: 15, fontWeight: '700', paddingHorizontal: 18},
  sub: {color: 'rgba(229,233,242,0.62)', fontSize: 12, paddingHorizontal: 18, paddingTop: 2, paddingBottom: 10},
  backRow: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 14, paddingBottom: 10},
  backText: {color: '#FFFFFF', fontSize: 15, fontWeight: '700', flex: 1},
  section: {color: 'rgba(180,188,204,0.45)', fontSize: 10, fontWeight: '800', letterSpacing: 1.4, paddingHorizontal: 18, paddingTop: 12, paddingBottom: 6},
  sending: {paddingVertical: 34, alignItems: 'center'},
  outsideRow: {flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 14, marginBottom: 4, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: 'rgba(30,136,255,0.10)', borderWidth: 1, borderColor: 'rgba(30,136,255,0.28)'},
  outsideIcon: {width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(30,136,255,0.16)'},
  outsideTitle: {color: '#FFFFFF', fontSize: 14, fontWeight: '700'},
  outsideSub: {color: 'rgba(229,233,242,0.62)', fontSize: 11.5, marginTop: 1},
});
