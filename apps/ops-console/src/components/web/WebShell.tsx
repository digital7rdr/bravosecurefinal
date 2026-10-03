'use client';

/**
 * Chrome of the Bravo Web App (web.bravosecure.cloud): rail, top bar, silent
 * session refresh and the idle sign-out.
 *
 * Everyone with a Bravo account may sign in. GET /auth/me says who they are:
 * client accounts see Book, Bookings and Secure Pro; officers, agencies and
 * agency managers see Messenger and Account only. The server is still the gate
 * for every booking call; hiding the pages is a convenience.
 */

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {useSWRConfig} from 'swr';
import {
  webAuth, readWebCsrf, useWebMe, useBalance, canBook, WEB_EXPIRES_KEY, WEB_IDLE_KEY, type WebMe,
} from '@/lib/web/api';
import {WEB_NAV, webNavActive, type WebNavIcon} from '@/lib/web/nav';
import {webRoutes} from '@/lib/web/routes';
import {useMessenger} from '@/components/messenger/MessengerProvider';
import {credits} from '@/lib/provider/labels';

const REFRESH_LEAD_SEC = 60;
// Longer than the consoles: a chat window is often left open and idle.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const RAIL_KEY = 'bravo_web_rail_collapsed';

interface WebCtx {
  me: WebMe;
  /** True for client accounts: booking pages are theirs. */
  client: boolean;
  signOut: () => void;
}

const Ctx = createContext<WebCtx | null>(null);

export function useWeb(): WebCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWeb outside WebShell');
  return v;
}

const ic = {width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true};

const ICONS: Record<WebNavIcon, ReactNode> = {
  chat: <svg {...ic}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>,
  plus: <svg {...ic}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v6M9 11h6"/></svg>,
  list: <svg {...ic}><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>,
  star: <svg {...ic}><path d="m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z"/></svg>,
  user: <svg {...ic}><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>,
};

function Splash({label}: {label: string}) {
  return (
    <div className="pv-splash">
      <div className="pv-spin"/>
      <div className="pv-splash-label">{label}</div>
    </div>
  );
}

export function WebShell({children}: {children: ReactNode}) {
  const path = usePathname() ?? '/';
  const {mutate} = useSWRConfig();
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const ok = !!readWebCsrf();
    setHasSession(ok);
    if (!ok) window.location.replace(webRoutes.login);
    try { setCollapsed(window.localStorage.getItem(RAIL_KEY) === '1'); } catch { /* ignore */ }
  }, []);

  const {data: me, error: meError} = useWebMe(hasSession === true);
  const client = canBook(me);
  const {data: balance} = useBalance(hasSession === true && client);

  const {wipe: wipeMessenger} = useMessenger();
  const signOut = useCallback(() => {
    // The encrypted vault (keys, history) is deleted from this browser so the
    // next person to sign in on it starts clean, same as the consoles.
    void wipeMessenger().catch(() => { /* sign-out always proceeds */ });
    void mutate(() => true, undefined, {revalidate: false});
    void webAuth.signOut().finally(() => window.location.replace(webRoutes.login));
  }, [mutate, wipeMessenger]);

  // Silent refresh ahead of the access-cookie expiry.
  useEffect(() => {
    if (hasSession !== true) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (expiresAt: number) => {
      const delay = Math.max(expiresAt - Date.now() - REFRESH_LEAD_SEC * 1000, 1_000);
      timer = setTimeout(async () => {
        try {
          const {expiresIn} = await webAuth.sessionRefresh();
          const next = Date.now() + expiresIn * 1000;
          window.sessionStorage.setItem(WEB_EXPIRES_KEY, String(next));
          schedule(next);
        } catch { signOut(); }
      }, delay);
    };
    const raw = window.sessionStorage.getItem(WEB_EXPIRES_KEY);
    schedule(raw ? Number(raw) : Date.now() + 15 * 60_000);
    return () => { if (timer) clearTimeout(timer); };
  }, [hasSession, signOut]);

  // Idle sign-out.
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (hasSession !== true) return;
    const fire = () => { window.sessionStorage.setItem(WEB_IDLE_KEY, '1'); signOut(); };
    const reset = () => { if (idle.current) clearTimeout(idle.current); idle.current = setTimeout(fire, IDLE_TIMEOUT_MS); };
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'] as const;
    for (const e of events) window.addEventListener(e, reset, {passive: true});
    reset();
    return () => {
      for (const e of events) window.removeEventListener(e, reset);
      if (idle.current) clearTimeout(idle.current);
    };
  }, [hasSession, signOut]);

  const value = useMemo<WebCtx | null>(() => (me ? {me, client, signOut} : null), [me, client, signOut]);

  if (hasSession !== true) return <Splash label="Loading…"/>;
  if (meError && !me) return <Splash label="Cannot reach Bravo Secure. Retrying…"/>;
  if (!value || !me) return <Splash label="Loading…"/>;

  const name = me.user.display_name ?? me.user.phone_e164 ?? 'Signed in';
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase() || 'BS';
  const nav = WEB_NAV.filter(i => !i.clientsOnly || client);
  const chatPage = path === '/' || path === '';

  return (
    <Ctx.Provider value={value}>
      <div className="app-shell" data-rail={collapsed ? 'collapsed' : 'expanded'}>
        <nav className="rail" aria-label="Bravo Secure Web">
          <div className="rail-head">
            <div className="rail-logo">
              {/* eslint-disable-next-line @next/next/no-img-element -- static SVG mark */}
              <img src="/bravo-mark-light.svg" alt="" width={22} height={17} aria-hidden="true"/>
            </div>
            <span className="rail-brand" style={{fontSize: 12, letterSpacing: 0}}>BRAVO SECURE</span>
            <button className="rail-toggle"
              onClick={() => { const n = !collapsed; setCollapsed(n); try { window.localStorage.setItem(RAIL_KEY, n ? '1' : '0'); } catch { /* ignore */ } }}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
              {collapsed ? '»' : '«'}
            </button>
          </div>
          <div className="rail-nav">
            <div className="rail-group-block">
              {nav.map(i => {
                const active = webNavActive(i.href, path);
                return (
                  <Link key={i.href} href={i.href} title={i.label}
                    aria-current={active ? 'page' : undefined}
                    className={`rail-item ${active ? 'active' : ''}`}>
                    <span className="rail-ic">{ICONS[i.icon]}</span>
                    <span className="rail-label">{i.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
          <div className="rail-sep"/>
        </nav>

        <header className="topbar">
          <div className="pv-org">
            <span className="pv-org-cap">Bravo Secure</span>
            <span className="pv-org-name">{client ? 'Messenger & booking' : 'Messenger'}</span>
          </div>
          <div style={{flex: 1}}/>
          {client && (
            <Link href={webRoutes.account} className="web-balance" title="Your Bravo credits">
              <span className="pv-hint">Credits</span>
              <span className="pv-strong">{balance ? credits(balance.bravo_credits) : '—'}</span>
            </Link>
          )}
          <div className="topbar-admin" style={{cursor: 'default'}}>
            <div className="topbar-admin-av">{initials}</div>
            <div>
              <div className="pv-user-name">{name}</div>
              <div className="pv-user-role">{client ? 'Client' : me.account_kind === 'cpo' ? 'Officer' : 'Service provider'}</div>
            </div>
            <button onClick={signOut} title="Sign out" className="pv-signout" style={{marginLeft: 6}}>Sign out</button>
          </div>
        </header>

        <main className={`main-area ${chatPage ? 'web-main-chat' : ''}`}>
          {children}
        </main>
      </div>
    </Ctx.Provider>
  );
}

/** A booking page opened by an account that cannot book. */
export function ClientsOnly() {
  return (
    <div className="card" style={{padding: 28, maxWidth: 560}}>
      <h2 style={{margin: '0 0 8px', fontSize: 18}}>Booking is for client accounts</h2>
      <p className="text-sm text-t3" style={{margin: 0, lineHeight: 1.6}}>
        This account belongs to an officer or a service provider, so it uses Bravo Secure for
        messaging only. Book protection with a personal client account.
      </p>
    </div>
  );
}
