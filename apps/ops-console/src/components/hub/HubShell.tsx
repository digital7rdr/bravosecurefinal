'use client';

/**
 * Frame of the Bravo Secure home site (bravosecure.cloud): the world-map
 * backdrop, the header with the account menu, silent session refresh and the
 * idle sign-out. GET /hub/apps is the one read every page shares: who is
 * signed in and the tiles, each with its state decided by the server.
 */
import Link from 'next/link';
import {createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode} from 'react';
import useSWR, {useSWRConfig, type KeyedMutator} from 'swr';
import {hubApi, hubAuth, readHubCsrf, HUB_EXPIRES_KEY, HUB_IDLE_KEY, type HubApps} from '@/lib/hub/api';
import {hubRoutes} from '@/lib/hub/routes';

const REFRESH_LEAD_SEC = 60;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

interface HubCtx {
  data: HubApps;
  reload: KeyedMutator<HubApps>;
  signOut: () => void;
}

const Ctx = createContext<HubCtx | null>(null);

export function useHub(): HubCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useHub outside HubShell');
  return v;
}

export function HubBackdrop({children}: {children: ReactNode}) {
  return (
    <div className="hub-page">
      <div className="hub-bg" aria-hidden="true"/>
      {children}
    </div>
  );
}

export function HubLogo() {
  return (
    <Link href={hubRoutes.home} className="hub-logo" aria-label="Bravo Secure home">
      {/* eslint-disable-next-line @next/next/no-img-element -- static SVG mark */}
      <img src="/bravo-mark-light.svg" alt="" width={74} height={56}/>
      <span className="hub-logo-text">
        <span className="hub-logo-name">BRAVO</span>
        <span className="hub-logo-sub">SECURE</span>
      </span>
    </Link>
  );
}

function Splash({label}: {label: string}) {
  return (
    <HubBackdrop>
      <div className="hub-splash"><div className="pv-spin"/><div className="pv-splash-label">{label}</div></div>
    </HubBackdrop>
  );
}

function AccountMenu({name, onSignOut}: {name: string; onSignOut: () => void}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase() || 'BS';
  return (
    <div className="hub-account" ref={ref}>
      <button className="hub-account-btn" onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open}>
        <span className="hub-avatar">{initials}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      {open && (
        <div className="hub-menu" role="menu">
          <div className="hub-menu-name">{name}</div>
          <Link role="menuitem" href={hubRoutes.security} className="hub-menu-item" onClick={() => setOpen(false)}>Security &amp; authenticator</Link>
          <button role="menuitem" className="hub-menu-item" onClick={onSignOut}>Sign out</button>
        </div>
      )}
    </div>
  );
}

export function HubShell({children}: {children: ReactNode}) {
  const {mutate} = useSWRConfig();
  const [hasSession, setHasSession] = useState<boolean | null>(null);

  useEffect(() => {
    const ok = !!readHubCsrf();
    setHasSession(ok);
    if (!ok) window.location.replace(hubRoutes.login);
  }, []);

  const {data, error, mutate: reload} = useSWR<HubApps>(hasSession ? ['hub', 'apps'] : null, hubApi.apps, {refreshInterval: 120_000});

  const signOut = useCallback(() => {
    void mutate(() => true, undefined, {revalidate: false});
    void hubAuth.signOut().finally(() => window.location.replace(hubRoutes.login));
  }, [mutate]);

  // Silent refresh ahead of the access-cookie expiry.
  useEffect(() => {
    if (hasSession !== true) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (expiresAt: number) => {
      const delay = Math.max(expiresAt - Date.now() - REFRESH_LEAD_SEC * 1000, 1_000);
      timer = setTimeout(async () => {
        try {
          const {expiresIn} = await hubAuth.sessionRefresh();
          const next = Date.now() + expiresIn * 1000;
          window.sessionStorage.setItem(HUB_EXPIRES_KEY, String(next));
          schedule(next);
        } catch { signOut(); }
      }, delay);
    };
    const raw = window.sessionStorage.getItem(HUB_EXPIRES_KEY);
    schedule(raw ? Number(raw) : Date.now() + 15 * 60_000);
    return () => { if (timer) clearTimeout(timer); };
  }, [hasSession, signOut]);

  // Idle sign-out.
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (hasSession !== true) return;
    const fire = () => { window.sessionStorage.setItem(HUB_IDLE_KEY, '1'); signOut(); };
    const reset = () => { if (idle.current) clearTimeout(idle.current); idle.current = setTimeout(fire, IDLE_TIMEOUT_MS); };
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'] as const;
    for (const e of events) window.addEventListener(e, reset, {passive: true});
    reset();
    return () => {
      for (const e of events) window.removeEventListener(e, reset);
      if (idle.current) clearTimeout(idle.current);
    };
  }, [hasSession, signOut]);

  if (hasSession !== true) return <Splash label="Loading…"/>;
  if (error && !data) return <Splash label="Cannot reach Bravo Secure. Retrying…"/>;
  if (!data) return <Splash label="Loading…"/>;

  const name = data.user.display_name ?? 'Bravo member';
  const first = name.split(/\s+/)[0];

  return (
    <Ctx.Provider value={{data, reload, signOut}}>
      <HubBackdrop>
        <header className="hub-header">
          <HubLogo/>
          <div className="hub-header-right">
            <div className="hub-hello">
              <div className="hub-hello-name">Welcome, {first}</div>
              <div className="hub-hello-sub">Stay Secure. Stay Ahead.</div>
            </div>
            <AccountMenu name={name} onSignOut={signOut}/>
          </div>
        </header>
        <main className="hub-main">{children}</main>
        <footer className="hub-footer">
          <div className="hub-footer-left"><span className="hub-rule"/>BRAVO SECURE <span className="hub-sep">|</span> <span className="hub-dim">SAFER PEOPLE. STRONGER OPERATIONS.</span></div>
          <div className="hub-footer-right"><span className="hub-stripes" aria-hidden="true"/><span className="hub-dim">GLOBAL REACH. LOCAL IMPACT.</span></div>
        </footer>
      </HubBackdrop>
    </Ctx.Provider>
  );
}
