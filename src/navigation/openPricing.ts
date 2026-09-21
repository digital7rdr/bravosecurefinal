import {CommonActions} from '@react-navigation/native';
import {navigationRef, mountedTreeHasRoute, focusedSiblingRoute} from './navigationRef';
import {Alert} from '@utils/alert';
import type {PricingReturn} from './types';

/**
 * M1A — jump to Settings → Pricing from anywhere (locked-feature prompts,
 * upgrade CTAs). Same root-dispatch pattern as the tier_insufficient
 * interceptor; a no-op until the container is ready.
 *
 * `Pricing` is registered in BookingNavigator ONLY, reached via `SecureTab`,
 * which exists only in the client tab shell. MainNavigator renders exactly one
 * of CpoNavigator / AgentNavigator / that tab shell — so in the Agent and CPO
 * shells this dispatch names a route the mounted tree does not have, the nested
 * payload goes unhandled, and the button is silently dead. That is the same
 * failure as Issues 18/19, and it was found (R6-4) on a CTA added to REPLACE a
 * working dialog, which would have made that persona strictly worse off.
 *
 * So: resolve against the mounted tree first, and say so out loud when the
 * route is not there rather than dropping the tap.
 */

export function openPricing(opts?: {only?: 'lite' | 'pro' | 'enterprise'}): boolean {
  if (!navigationRef.isReady()) {return false;}
  if (!mountedTreeHasRoute('SecureTab')) {
    Alert.alert(
      'Plans unavailable here',
      'Subscription plans are managed from your personal account dashboard. Sign in with the account that holds the subscription to change it.',
    );
    return false;
  }
  // B-870 — THIS dispatch is what moves the user off the tab they were on, so
  // it is the one place that can record where back should return them. Read off
  // the mounted tree, never handed in by a caller. Already on SecureTab there is
  // nothing to return to, and the plain pop this screen always had is right.
  const from = focusedSiblingRoute('SecureTab');
  const returnTab = from && from !== 'SecureTab'
    ? (from as NonNullable<PricingReturn['returnTab']>)
    : undefined;
  // `initial: false` — SecureTab is lazy whenever the user is in the messenger
  // product, so without it BookingNavigator's FIRST mount roots at Pricing.
  // The tabPress listener then pushes BookingHome on top, and back from the
  // booking home lands on the pricing page for the life of the tab tree.
  //
  // The nested params are passed WHOLE (both keys, even when undefined) rather
  // than omitted: React Navigation lands this on an existing `Pricing` route
  // when there is one, and an omitted key cannot clear a stamp left by an
  // earlier door.
  navigationRef.dispatch(
    CommonActions.navigate('Main', {
      screen: 'SecureTab',
      params: {screen: 'Pricing', initial: false, params: {only: opts?.only, returnTab}},
    }),
  );
  return true;
}

/**
 * B-781 — the workspace door. "Department Channels are available on
 * Enterprise" must land on the Enterprise card alone: the founder does not
 * want the free and Pro cards offered from a door that is about Enterprise.
 */
export function openEnterprisePricing(): boolean {
  return openPricing({only: 'enterprise'});
}
