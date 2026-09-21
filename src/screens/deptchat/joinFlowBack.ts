/**
 * B-816 (founder, 2026-09-07) — "If I enter approvals and press back it enters
 * Channels. It should go back to the dashboard I was previously on."
 *
 * Inside the Departmental shell the join-flow screens (Approvals, JoinWorkspace,
 * ApprovalStatus, EnterpriseSetup) are PUSHED ON THE CHANNELS STACK by
 * `openJoinFlowScreen`'s tab hop — deliberately, so the tab bar stays (R8-5).
 * The cost was the back press: a pop lands on the Channels root, not on the
 * Home dashboard the admin tapped the Approvals card from. The hop now stamps
 * `returnTab` (the tab the user came FROM, read off the tab navigator's state)
 * and this hook honours it: pop the screen, then re-focus that tab.
 *
 * NAV loop invariants: the hardware handler is `useFocusEffect`-scoped (N1 — a
 * mount-scoped one would eat the first back press on every screen pushed above
 * this one); the chevron goes through `ObHeader`, which already guards once
 * (N5); programmatic backs elsewhere in these screens are untouched (N2).
 */
import {useCallback} from 'react';
import {BackHandler} from 'react-native';
import {useFocusEffect, useNavigation, useRoute} from '@react-navigation/native';
import {findNavigatorWithRoute, navigateVia, type RouteAwareNavigation} from '@navigation/departmentalEntry';
import type {JoinFlowReturn} from '@navigation/types';

export interface PoppableNavigation extends RouteAwareNavigation {
  goBack: () => void;
}

/**
 * Pop the current screen, then focus `returnTab` on the nearest navigator that
 * registers it. Returns whether such a tab was found — when it is not (a torn
 * tree, a stale param from another shell) the pop alone still happened, so the
 * press is never swallowed.
 */
export function returnToTab(nav: PoppableNavigation, returnTab: string): boolean {
  const tabs = findNavigatorWithRoute(nav, returnTab);
  // Pop FIRST: switching tabs while this screen is still on the Channels stack
  // would leave it there, and the next Channels tap would land on it again.
  nav.goBack();
  if (!tabs) {return false;}
  navigateVia(tabs, returnTab);
  return true;
}

/** The back action for a join-flow screen's header chevron; also wires the
 *  hardware key while focused when a `returnTab` is present. */
export function useJoinFlowBack(): () => void {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const returnTab = (route.params as JoinFlowReturn | undefined)?.returnTab;

  const onBack = useCallback(() => {
    if (returnTab) {
      returnToTab(navigation as PoppableNavigation, returnTab);
    } else {
      navigation.goBack();
    }
  }, [navigation, returnTab]);

  useFocusEffect(useCallback(() => {
    if (!returnTab) {return undefined;}
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [returnTab, onBack]));

  return onBack;
}
