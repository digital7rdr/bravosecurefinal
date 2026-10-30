'use client';

/**
 * Chrome of the Bravo Web App (web.bravosecure.cloud): rail, top bar, silent
 * session refresh and the idle sign-out.
 *
 * Everyone with a Bravo account may sign in. GET /auth/me says who they are.
 * Owner 2026-10-23: the web app is the messenger — Chats, Contacts, Groups and
 * Account for every account. Owner 2026-10-30: Secure Services (Book, My
 * bookings, Secure Pro) is back for Pro and Enterprise clients, opened from the
 * home site tile and kept out of this rail (components/web/SecureServices).
 */

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {useSWRConfig} from 'swr';
import {
  webAuth, readWebCsrf, useWebMe, canBook, WEB_EXPIRES_KEY, WEB_IDLE_KEY, type WebMe,
} from '@/lib/web/api';
import {HomeSiteLink} from '@/components/HomeSiteLink';
import {webNavFor, webNavActive, type WebNavIcon} from '@/lib/web/nav';
import {webRoutes} from '@/lib/web/routes';
import {useMessenger} from '@/components/messenger/MessengerProvider';
import {IDLE_SIGN_OUT_MS} from '@/lib/idleSignOut';

const REFRESH_LEAD_SEC = 60;
// Longer than the consoles: a chat window is often left open and idle.
// 2026-10-25 — off unless NEXT_PUBLIC_IDLE_SIGN_OUT_MINUTES is set (lib/idleSignOut).
const IDLE_TIMEOUT_MS = IDLE_SIGN_OUT_MS;
const RAIL_KEY = 'bravo_web_rail_collapsed';

interface WebCtx {
  me: WebMe;
  /** True for client accounts (personal Bravo accounts). */
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
  contacts: <svg {...ic}><rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M7.5 17c.8-1.8 2.5-3 4.5-3s3.7 1.2 4.5 3"/></svg>,
  group: <svg {...ic}><circle cx="9" cy="8" r="3.2"/><path d="M3 20c.7-3.2 3.1-5 6-5s5.3 1.8 6 5"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 14.2c2.4.2 4 1.8 4.5 4.8"/></svg>,
  user: <svg {...ic}><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>,
  workspace: <svg {...ic}><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 13h18"/></svg>,
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
    if (!IDLE_TIMEOUT_MS) return; // idle sign-out switched off
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
  const nav = webNavFor(me);
  const chatPage = path === '/' || path === '' || webNavActive(webRoutes.contacts, path) || webNavActive(webRoutes.groups, path);
  // 2026-10-30 — Secure Services pages (opened from the home site, not the rail).
  const servicesPage = [webRoutes.book, webRoutes.bookings, webRoutes.pro].some(h => webNavActive(h, path));

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
            <span className="pv-org-name">{servicesPage ? 'Secure Services' : 'Messenger'}</span>
          </div>
          <div style={{flex: 1}}/>
          <HomeSiteLink/>
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
