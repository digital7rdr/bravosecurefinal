/**
 * B-870 (founder, 2026-09-12) — "when he goes to Channels he sees invitation
 * and upgrade plan. When he is on the plan page and tries to go back, he goes
 * back to the Secure Services page. The navigation thing is broken, fix it."
 *
 * `openPricing` is a ROOT dispatch — `Main → SecureTab → Pricing` — so opening
 * the plan ladder moves the user off whatever root tab they were on and pushes
 * Pricing onto BookingNavigator's stack, which is rooted at `BookingHome` (the
 * screen titled "SECURE SERVICES"). A plain pop from Pricing therefore ALWAYS
 * lands on Secure Services, whichever door the user came through.
 *
 * This is B-816 one level up. That fix taught `openJoinFlowScreen`'s
 * DEPARTMENTAL tab hop to stamp the tab the user came from and taught the
 * pushed screen to return there; the plan door is the same hop across ROOT
 * tabs, and it stamped nothing. So the same two halves: `openPricing` records
 * the focused root tab (never a caller-supplied param — six call sites open
 * this door and none of them knows which tab is focused), and this hook honours
 * it.
 *
 * NAV loop invariants: the pop keeps `goBackOnce` (N2/B-261 — Pricing's chevron
 * always had it, and a swallowed repeat must not hop a tab on its own); the
 * hardware key is registered inside `useFocusEffect` (N1 — a mount-scoped
 * handler here would eat the first back press on `TierPaywall`, which is pushed
 * on top of this screen); nothing programmatic is guarded (N2's scope rule).
 */
import {useCallback} from 'react';
import {BackHandler} from 'react-native';
import {useFocusEffect, useNavigation, useRoute} from '@react-navigation/native';
import {findNavigatorWithRoute, navigateVia, type RouteAwareNavigation} from '@navigation/departmentalEntry';
import {goBackOnce} from '@navigation/tapGuard';
import type {PricingReturn} from '@navigation/types';

/** The back action for the Pricing header chevron; also wires the hardware key
 *  while focused, but only when there is a stamped tab to return to. */
export function usePricingBack(): () => void {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const returnTab = (route.params as PricingReturn | undefined)?.returnTab;

  const onBack = useCallback(() => {
    // Resolved against the mounted tree, not assumed: this screen is reached
    // from the client tab shell only, but a stale param (an old stack restored
    // into a shell without that tab) must degrade to the plain pop rather than
    // dropping a navigate into nothing.
    const tabs = returnTab
      ? findNavigatorWithRoute(navigation as RouteAwareNavigation, returnTab)
      : null;
    // Pop FIRST. Focusing the other tab while Pricing is still on the SecureTab
    // stack leaves it there, and the next entry into Secure pushes
    // `SecureLanding` ON TOP of it — the plan page back in the user's way, and
    // one back press behind every later screen.
    if (!goBackOnce(navigation)) {return;}
    if (returnTab && tabs) {navigateVia(tabs, returnTab);}
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
