'use client';

import {SignInFlow} from '@/components/SignInFlow';
import type {AuthBrand} from '@/components/auth-primitives';
import {pvAuth, PV_CSRF_COOKIE, PV_EXPIRES_KEY, PV_IDLE_KEY} from '@/lib/provider/api';

const BRAND: AuthBrand = {
  kicker: 'Provider Console',
  headline: 'Run your security agency',
  lede: 'Accept Lite and Executive jobs, crew and dispatch your officers, track live missions and follow your earnings.',
  points: [
    'Offers, crew assignment and live tracking',
    'Officer roster, invitations and manager access',
    'Two-step verification on every account',
  ],
  foot: 'For Bravo Secure service providers. Sign-ins and activity are logged.',
};

/**
 * After the code is accepted, confirm the account actually runs an agency.
 * A client or officer account gets a clear reason and is signed out again,
 * instead of landing on a console that would refuse every call.
 */
async function requireAgency(): Promise<string | null> {
  try {
    const ctx = await pvAuth.context();
    if (ctx.orgs.length > 0) return null;
  } catch {
    return 'Signed in, but the provider details could not be loaded. Try again.';
  }
  await pvAuth.signOut();
  return 'This account is not the owner or a manager of a service provider. Use the Bravo Secure app, or ask your agency owner to make you a manager.';
}

const api = {
  loginStart: pvAuth.loginStart,
  loginVerify: pvAuth.loginVerify,
};

export default function ProviderLoginPage() {
  return (
    <SignInFlow
      api={api}
      csrfCookie={PV_CSRF_COOKIE}
      expiresKey={PV_EXPIRES_KEY}
      idleKey={PV_IDLE_KEY}
      homeHref="/"
      accountNoun="service provider"
      brand={BRAND}
      afterSignIn={requireAgency}
    />
  );
}
