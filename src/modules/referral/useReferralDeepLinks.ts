import {useEffect} from 'react';
import * as Linking from 'expo-linking';
import {parseReferralUrl} from './referralLinks';
import {useReferralStore} from '@store/referralStore';

/**
 * Catch referral deep links (2026-09-05) and park the code for the next booking.
 *
 * Mounted ONCE at the app root, deliberately OUTSIDE the navigator: the root
 * stack is auth- and permission-gated (Auth → PermGate → Main) and its Main
 * branch differs per account kind, so a React Navigation `linking` config
 * that tried to route into the booking wizard would have to know all of that.
 * Parking the code in a persisted store and letting the booking screens
 * pre-fill from it works on a cold open before sign-in, on a warm open, and
 * a week later — and touches no navigation at all (NAV loop: nothing here
 * navigates, so N3 does not apply).
 *
 * Both the initial URL (cold open) and later `url` events (warm open) are
 * read; a URL that is not a referral link is ignored.
 */
export function useReferralDeepLinks(): void {
  useEffect(() => {
    let alive = true;
    const handle = (url: string | null | undefined) => {
      const code = parseReferralUrl(url);
      if (code && alive) {useReferralStore.getState().setPending(code);}
    };
    Linking.getInitialURL().then(handle).catch(() => undefined);
    const sub = Linking.addEventListener('url', e => handle(e.url));
    return () => { alive = false; sub.remove(); };
  }, []);
}
