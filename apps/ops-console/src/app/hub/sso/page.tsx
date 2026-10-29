'use client';

import {SsoLanding} from '@/components/SsoLanding';
import {HUB_EXPIRES_KEY} from '@/lib/hub/api';

/**
 * Bravo Secure home site: signed in from an app's "All apps" link
 * (2026-10-30). The app minted a one-time code for this origin; this page
 * trades it for the home site's own session, then opens the launcher.
 */
export default function HubSso() {
  return <SsoLanding expiresKey={HUB_EXPIRES_KEY}/>;
}
