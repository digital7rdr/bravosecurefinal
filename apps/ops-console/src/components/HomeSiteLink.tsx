'use client';

/**
 * "All apps" — back to the Bravo Secure home site (bravosecure.cloud, the
 * launcher with the app tiles). Shown in the top bar of the Control Console,
 * the provider console and the web app (2026-10-11). The address is worked
 * out from the current host after mount, so server and client render alike.
 *
 * 2026-10-30 (owner: "on the Ops console, navigating to all apps landed on
 * the login page") — the home site keeps its own session, so a plain link
 * asked the person to sign in again. A click now asks the auth-service for a
 * one-time hand-off code (POST /hub/handoff, from THIS app's cookie session)
 * and opens the home site signed in. Any failure falls back to the plain
 * address, i.e. the old behaviour.
 */
import {useEffect, useState, type MouseEvent} from 'react';
import {homeSiteUrl, isHomeSiteRedirect} from '@/lib/sso';
import {readSessionCsrf} from '@/lib/provider/host';

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

export function HomeSiteLink() {
  const [href, setHref] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setHref(homeSiteUrl(window.location)); }, []);
  if (!href) return null;

  const open = async (e: MouseEvent<HTMLAnchorElement>) => {
    // Modified clicks (new tab / window) keep the plain link.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const csrf = readSessionCsrf();
      const res = await fetch(`${BASE}/hub/handoff`, {
        method: 'POST', credentials: 'include', cache: 'no-store',
        headers: {'Content-Type': 'application/json', ...(csrf ? {'X-CSRF-Token': csrf} : {})},
        body: '{}',
      });
      const body = res.ok ? await res.json() as {redirect?: unknown} : null;
      const target = body?.redirect;
      window.location.assign(isHomeSiteRedirect(target, href) ? target : href);
    } catch {
      window.location.assign(href);
    }
  };

  return (
    <a href={href} className="home-site-link" title="Back to Bravo Secure home (all apps)"
      onClick={e => void open(e)} aria-busy={busy}>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
        <rect x="1" y="1" width="6" height="6" rx="1.5"/><rect x="9" y="1" width="6" height="6" rx="1.5"/>
        <rect x="1" y="9" width="6" height="6" rx="1.5"/><rect x="9" y="9" width="6" height="6" rx="1.5"/>
      </svg>
      <span>{busy ? 'Opening…' : 'All apps'}</span>
    </a>
  );
}
