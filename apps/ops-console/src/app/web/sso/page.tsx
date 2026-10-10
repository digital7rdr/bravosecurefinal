'use client';

import {SsoLanding} from '@/components/SsoLanding';
import {WEB_EXPIRES_KEY} from '@/lib/web/api';

/** Bravo Web App: single sign-on from the Bravo Secure home site. */
export default function WebSso() {
  return <SsoLanding expiresKey={WEB_EXPIRES_KEY}/>;
}
