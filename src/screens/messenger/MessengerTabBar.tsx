/**
 * The Messenger footer bar — Chats · Calls · Files · Channels · Contacts · News (PDF-2 N5),
 * PERSISTENT (N1): MessengerHome keeps it always mounted and swaps tab bodies
 * inline; and, since the client's 2026-08-22 feedback ("No Nav bar?" on Files),
 * the pushed Files screen renders the SAME bar with Files lit, so the footer
 * never disappears inside Messenger.
 *
 * Extracted from MessengerHomeScreen so two screens share ONE bar (the
 * duplicate-copy bug class: one behaviour, N drifted copies). The tab semantics
 * are unchanged:
 *   `tab`   — a LOCAL tab of MessengerHome (Chats / Calls / News): the host flips
 *             its body inline via `onSelectTab`; from Files the host navigates
 *             back to MessengerHome carrying the tab as a route param.
 *   `route` — a BARE in-stack PUSH (Files only; its B-453 vault-PIN gate uses
 *             navigation.replace and cannot embed, so it stays full-screen —
 *             but it now renders this bar beneath its list).
 *   `exit`  — a shell-aware EXIT-HOP out of the messenger stack (Channels), so it
 *             reaches a cross-shell MessengerTarget a bare navigate would drop in
 *             some shells (B-414).
 */
import React, {useRef} from 'react';
import {View, Text, TouchableOpacity, StyleSheet} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList, MessengerHomeTab} from '@navigation/types';
import {navigateToMessengerScreen, type MessengerTarget} from '@navigation/messengerDeepLink';
import {openWorkspaceHub} from '@navigation/departmentalEntry';
import {NAV_GUARD_MS} from '@navigation/tapGuard';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {useMessengerStore} from '@/modules/messenger/store/messengerStore';
import {resolveDeptConversation} from '@/modules/messenger/push/deptChannelTarget';

/**
 * 2026-10-30 (owner: "in the respective location there must be a number
 * indicating the notification") — unread messages behind the Chats and
 * Channels tabs, so a notification's count is visible where it leads.
 * Channels = department-channel conversations; Chats = everything else that
 * is not muted. Pure, so it is testable without React.
 */
export function messengerTabCounts(
  conversations: Record<string, {unread_count?: number; is_muted?: boolean} | undefined>,
  maps: Parameters<typeof resolveDeptConversation>[1],
): {chats: number; channels: number} {
  let chats = 0;
  let channels = 0;
  for (const [id, c] of Object.entries(conversations)) {
    const n = c?.unread_count ?? 0;
    if (n <= 0) {continue;}
    if (resolveDeptConversation(id, maps)) {channels += n;}
    else if (!c?.is_muted) {chats += n;}
  }
  return {chats, channels};
}

/**
 * ONE store subscription, memoised on the three inputs' identities (the
 * selectCallMessages pattern): the counts object is stable until a
 * conversation, or the channel registry, actually changes, so the bar does not
 * re-render on unrelated store writes (W3(b) census).
 */
type TabCounts = {chats: number; channels: number};
let lastInputs: [unknown, unknown, unknown] | null = null;
let lastCounts: TabCounts = {chats: 0, channels: 0};
function selectTabCounts(s: ReturnType<typeof useMessengerStore.getState>): TabCounts {
  if (lastInputs && lastInputs[0] === s.conversations && lastInputs[1] === s.deptConversationIds
      && lastInputs[2] === s.deptGroupByChannel) {return lastCounts;}
  const next = messengerTabCounts(s.conversations, {
    deptConversationIds: s.deptConversationIds, deptGroupByChannel: s.deptGroupByChannel,
  });
  lastInputs = [s.conversations, s.deptConversationIds, s.deptGroupByChannel];
  if (next.chats !== lastCounts.chats || next.channels !== lastCounts.channels) {lastCounts = next;}
  return lastCounts;
}

/** The tabs MessengerHome renders INLINE (local state, no navigation). */
export type MsgLocalTab = MessengerHomeTab;
/** What the bar can show as lit: a local tab, or Files while the Files screen hosts it. */
export type MsgBarTab = MsgLocalTab | 'Files';

/** Height of the bar's content above the safe-area pad — hosts clear it. */
export const MSG_TAB_HEIGHT = 60;

/**
 * What the bar needs from its host's navigation: `navigate` only. Structural,
 * so a host typed for ANY route of the stack (MessengerHome, Files) can pass
 * its own prop — `NativeStackNavigationProp<P, 'Files'>` is not assignable to
 * `NativeStackNavigationProp<P>` (the route-bound members differ).
 */
export type MessengerBarNavigation = Pick<NativeStackNavigationProp<MessengerStackParamList>, 'navigate'>;

const BAR_BG = '#0A1F3F';

type MsgTab = {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  tab?: MsgLocalTab;
  route?: keyof MessengerStackParamList;
  exit?: MessengerTarget;
};
// N5 (PDF-2) — footer is Chats · Calls · Files · News · Channels. The Groups
// footer tab was dropped: group conversations still appear in the Chats list
// and "New Group" lives on the header pencil (NewChat). Channels is an EXIT-HOP
// to the departmental tree, reached in every shell via the resolver.
// Founder 2026-09-02 — News sits at the FAR RIGHT so the first four slots
// (Chats · Calls · Files · Channels) line up with the VBS/Channels bars.
export const MSG_TABS: MsgTab[] = [
  {icon: 'message-text-outline',      label: 'Chats',    tab: 'Chats'},
  {icon: 'phone-outline',             label: 'Calls',    tab: 'Calls'},
  {icon: 'folder-outline',            label: 'Files',    route: 'Files'},
  {icon: 'pound-box-outline',         label: 'Channels', exit: 'DepartmentChannels'},
  // Owner 2026-10-23 — a Contacts tab (phone-book + added by hand). After
  // Channels so the first four slots still line up with the VBS/Channels bars.
  {icon: 'account-box-outline',       label: 'Contacts', tab: 'Contacts'},
  {icon: 'newspaper-variant-outline', label: 'News',     tab: 'News'},
];


export function MessengerTabBar({
  navigation,
  insets,
  activeTab,
  onSelectTab,
  // Defaults TRUE: an un-updated caller keeps the tab rather than silently
  // losing a door. Hiding on omission would be the worse failure.
  showChannels = true,
}: {
  navigation: MessengerBarNavigation;
  insets: {bottom: number};
  activeTab: MsgBarTab;
  onSelectTab: (tab: MsgLocalTab) => void;
  /**
   * B-661 - whether this account is offered Channels. The HOSTS decide, via
   * the shared canSeeChannels(user) rule; the bar deliberately does NOT read
   * the auth store itself - see channelsAccess.ts for why that shape was
   * backed out. Defaults to TRUE so an un-updated caller keeps the tab
   * rather than silently losing a door.
   */
  showChannels?: boolean;
}) {
  // B-661 - LITE does not get Channels. Rule: channelsAccess.canSeeChannels.
  const visibleTabs = React.useMemo(
    () => (showChannels ? MSG_TABS : MSG_TABS.filter(t => t.exit !== 'DepartmentChannels')),
    [showChannels],
  );

  // NAV-10 (2026-08-26 audit) — drop same-tab repeats inside the guard
  // window: a local tab press fully remounts its body (B-655 gating), so a
  // mash used to queue one full unmount/remount cycle per tap. A press on a
  // DIFFERENT tab always passes.
  const lastTabTapRef = useRef<{label: string; t: number} | null>(null);
  const counts = useMessengerStore(selectTabCounts);
  const handlePress = (tab: MsgTab) => {
    const now = Date.now();
    const last = lastTabTapRef.current;
    if (last && last.label === tab.label && now - last.t < NAV_GUARD_MS) {return;}
    lastTabTapRef.current = {label: tab.label, t: now};
    /**
     * Channels lands on the WORKSPACE LIST, not inside one workspace.
     *
     * Client 2026-08-22: "if I click Channels it redirects to my workspace's
     * manage channels — it does not make sense; it should go to the workspace
     * interface where all the workspaces are listed." It is also the fix for the
     * mixed-organisation list: the org context every scoped surface reads
     * (`activeWorkspace`) is set by PICKING a workspace on that hub, and is null
     * on every other entry — which is precisely when the server returns channels
     * from every org at once.
     *
     * Resolved, never assumed: `WorkspaceHub` is registered on the messenger and
     * agency stacks, but a shell without it must not get a dead tap (B-414/N2),
     * so an unresolved hub falls back to the previous channels exit-hop.
     */
    if (tab.exit === 'DepartmentChannels') {
      // B-848 / F6 — the SHARED ladder. This copy only ever walked ancestors,
      // so it missed the client shell's SIBLING MessengerTab branch, and it
      // skipped `navigateOnce` — on the one control a user mashes, whose queued
      // dispatches their next back press then waits behind (NAV-10).
      if (openWorkspaceHub(navigation as never).ok) {return;}
      navigateToMessengerScreen(navigation as never, 'DepartmentChannels', {}, {initial: false});
      return;
    }
    // Files STAYS a push — embedding its vault-PIN gate would run
    // navigation.replace against MessengerHome and strand the user. A re-press
    // while Files already hosts the bar is a no-op (never a second push).
    if (tab.route === 'Files') {
      if (activeTab !== 'Files') {navigation.navigate('Files');}
      return;
    }
    // A local tab: the host decides (MessengerHome flips its inline body; Files
    // pops back to MessengerHome with the tab) — the bar never navigates itself.
    if (tab.tab) {onSelectTab(tab.tab);}
  };
  return (
    <View style={[msgTabStyles.bar, {paddingBottom: Math.max(insets.bottom, 8)}]}>
      <View style={msgTabStyles.hairline} />
      <View style={msgTabStyles.row}>
        {visibleTabs.map(tab => {
          // The highlight follows what the HOST declares is live — a local tab on
          // MessengerHome, or Files while the Files screen hosts the bar. Channels
          // is never "active" (it leaves this surface).
          const active = (tab.tab ?? tab.route) === activeTab;
          return (
            <TouchableOpacity
              key={tab.label}
              style={msgTabStyles.item}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={tab.label}
              accessibilityState={{selected: active}}
              hitSlop={{top: 8, bottom: 8, left: 4, right: 4}}
              onPress={() => handlePress(tab)}>
              {active && <View style={msgTabStyles.activeBar} />}
              <View>
                <Icon name={tab.icon} size={22} color={active ? '#1E88FF' : 'rgba(180,188,204,0.45)'} />
                {(() => {
                  const n = tab.tab === 'Chats' ? counts.chats : tab.exit === 'DepartmentChannels' ? counts.channels : 0;
                  return n > 0 ? (
                    <View style={msgTabStyles.badge} accessibilityLabel={`${n} unread`}>
                      <Text style={msgTabStyles.badgeText} maxFontSizeMultiplier={1.1}>{n > 99 ? '99+' : n}</Text>
                    </View>
                  ) : null;
                })()}
              </View>
              {/* 2026-10-30 (owner screenshot: CHANNELS and CONTACTS ran into each
                  other). Cause: Android measures a `textTransform: 'uppercase'`
                  line in its ORIGINAL case and then paints it in capitals, so
                  the drawn word was wider than both FitLine's measurement and
                  the slot. The label is upper-cased in the string instead, and
                  the slot clips (and the label ellipsises)
                  rather than letting a long word paint over its neighbour. */}
              <View style={msgTabStyles.labelClip}>
                <FitLine style={[msgTabStyles.label, active && msgTabStyles.labelActive]} floorScale={0.75} text={tab.label.toUpperCase()} />
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const msgTabStyles = StyleSheet.create(scaleTextStyles({
  bar: {
    backgroundColor: BAR_BG,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
    paddingTop: 10,
  },
  hairline: {},
  row: {flexDirection: 'row', alignItems: 'flex-start'},
  item: {flex: 1, minWidth: 0, paddingHorizontal: 1, alignItems: 'center', justifyContent: 'flex-start', gap: 3, position: 'relative'},
  badge: {
    position: 'absolute', top: -6, right: -12, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#1E88FF', borderWidth: 1.5, borderColor: BAR_BG,
  },
  badgeText: {color: '#FFFFFF', fontSize: 10, fontWeight: '800'},
  labelClip: {alignSelf: 'stretch', minWidth: 0, overflow: 'hidden'},
  activeBar: {
    position: 'absolute', top: -10, width: 28, height: 2.5, borderRadius: 2,
    backgroundColor: '#1E88FF',
    shadowColor: '#1E88FF', shadowOpacity: 1, shadowRadius: 8, shadowOffset: {width: 0, height: 0}, elevation: 4,
  },
  label: {fontFamily: BravoFont.sans, fontSize: 10, fontWeight: '600', letterSpacing: 0.2, textAlign: 'center', color: 'rgba(180,188,204,0.45)'},
  labelActive: {color: '#FFFFFF'},
}));
