'use client';

/**
 * "All apps" — back to the Bravo Secure home site (bravosecure.cloud, the
 * launcher with the app tiles). Shown in the top bar of the Control Console,
 * the provider console and the web app (2026-10-11). The address is worked
 * out from the current host after mount, so server and client render alike.
 */
import {useEffect, useState} from 'react';
import {homeSiteUrl} from '@/lib/sso';

export function HomeSiteLink() {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => { setHref(homeSiteUrl(window.location)); }, []);
  if (!href) return null;
  return (
    <a href={href} className="home-site-link" title="Back to Bravo Secure home (all apps)">
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
        <rect x="1" y="1" width="6" height="6" rx="1.5"/><rect x="9" y="1" width="6" height="6" rx="1.5"/>
        <rect x="1" y="9" width="6" height="6" rx="1.5"/><rect x="9" y="9" width="6" height="6" rx="1.5"/>
      </svg>
      <span>All apps</span>
    </a>
  );
}
