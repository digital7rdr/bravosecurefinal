'use client';

/**
 * Single sign-on landing (2026-10-10). The Bravo Secure home site sends the
 * browser here as https://<this app>/sso#code=…&next=/path. This page trades
 * the one-time code for THIS app's own session (POST /auth/sso/exchange from
 * this origin; the auth-service sets this app's cookies), then opens `next`.
 *
 * The code is in the fragment, so it never reaches a server log; it is wiped
 * from the address bar before anything else happens.
 */
import {useEffect, useState} from 'react';
import {deviceId} from '@/lib/api';
import {homeSiteUrl, safeNext} from '@/lib/sso';

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

export function SsoLanding({expiresKey}: {expiresKey: string}) {
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const code = params.get('code');
    const next = safeNext(params.get('next'));
    window.history.replaceState(null, '', window.location.pathname);
    if (!code) { setErr('This sign-in link is incomplete. Open the app again from the Bravo Secure home page.'); return; }
    (async () => {
      try {
        const res = await fetch(`${BASE}/auth/sso/exchange`, {
          method: 'POST', credentials: 'include', cache: 'no-store',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({code, deviceId: deviceId()}),
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as {expiresIn?: number};
        try { window.sessionStorage.setItem(expiresKey, String(Date.now() + (body.expiresIn ?? 900) * 1000)); } catch { /* ignore */ }
        window.location.replace(next);
      } catch {
        setErr('This sign-in link has expired or was already used. Open the app again from the Bravo Secure home page.');
      }
    })();
  }, [expiresKey]);

  return (
    <div className="pv-splash">
      {err ? (
        <div className="auth-card" style={{maxWidth: 440, textAlign: 'center'}}>
          {/* eslint-disable-next-line @next/next/no-img-element -- static SVG logo */}
          <img src="/bravo-logo-light.svg" alt="Bravo Secure" width={110} height={79} style={{margin: '0 auto 18px', display: 'block'}}/>
          <p className="auth-desc">{err}</p>
          <a className="btn btn-pri auth-submit" href={typeof window !== 'undefined' ? homeSiteUrl(window.location) : '/'}>Back to Bravo Secure</a>
        </div>
      ) : (
        <>
          <div className="pv-spin"/>
          <div className="pv-splash-label">Signing you in…</div>
        </>
      )}
    </div>
  );
}
