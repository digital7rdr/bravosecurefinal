'use client';

import {SsoLanding} from '@/components/SsoLanding';

/** Ops console: single sign-on from the Bravo Secure home site. */
export default function OpsSso() {
  return <SsoLanding expiresKey="bravo_ops_access_expires_at"/>;
}
