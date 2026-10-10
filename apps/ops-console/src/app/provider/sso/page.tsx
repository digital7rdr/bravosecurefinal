'use client';

import {SsoLanding} from '@/components/SsoLanding';
import {PV_EXPIRES_KEY} from '@/lib/provider/api';

/** Provider console: single sign-on from the Bravo Secure home site. */
export default function ProviderSso() {
  return <SsoLanding expiresKey={PV_EXPIRES_KEY}/>;
}
