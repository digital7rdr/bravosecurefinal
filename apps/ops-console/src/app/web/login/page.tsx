'use client';

import {SignInFlow} from '@/components/SignInFlow';
import type {AuthBrand} from '@/components/auth-primitives';
import {webAuth, WEB_CSRF_COOKIE, WEB_EXPIRES_KEY, WEB_IDLE_KEY, WEB_PW_CHANGED_KEY} from '@/lib/web/api';
import {webRoutes} from '@/lib/web/routes';

const NOTICES = [{key: WEB_PW_CHANGED_KEY, text: 'Password changed. Sign in again with your new password.'}];

const BRAND: AuthBrand = {
  kicker: 'Bravo Secure Web',
  headline: 'Messenger and booking on your computer',
  lede: 'Chat end to end encrypted with your Bravo contacts and book secure transfers and protection, paid with your Bravo credits.',
  points: [
    'End-to-end encrypted chats, like the app',
    'Book Lite and Executive protection, request Secure Pro',
    'Two-step verification on every account',
  ],
  foot: 'Use the same phone number and password as the Bravo Secure app.',
};

/**
 * An account still waiting for its first password (an officer invite) has to
 * finish that in the app; the web app cannot help it yet.
 */
async function checkAccount(): Promise<string | null> {
  try {
    const me = await webAuth.me();
    if (!me.must_set_password) return null;
  } catch {
    return 'Signed in, but your account could not be loaded. Try again.';
  }
  await webAuth.signOut();
  return 'Finish setting up this account in the Bravo Secure app first (choose your password there), then sign in here.';
}

const api = {loginStart: webAuth.loginStart, loginVerify: webAuth.loginVerify};

export default function WebLoginPage() {
  return (
    <SignInFlow
      api={api}
      csrfCookie={WEB_CSRF_COOKIE}
      expiresKey={WEB_EXPIRES_KEY}
      idleKey={WEB_IDLE_KEY}
      homeHref={webRoutes.home}
      accountNoun="Bravo Secure"
      brand={BRAND}
      afterSignIn={checkAccount}
      notices={NOTICES}
    />
  );
}
