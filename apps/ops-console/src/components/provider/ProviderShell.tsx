'use client';

/**
 * Chrome of the service provider console: rail, top bar, agency switcher,
 * silent session refresh and the 15-minute idle sign-out.
 *
 * Access: GET /org/console/context lists the security agencies this person
 * runs (owner) or helps run (delegated manager). An empty list means the
 * account is not a service provider, and the console says so instead of
 * showing empty pages. The rail shows only the modules the owner granted; the
 * server enforces the same grant on every call (OrgModuleGuard), so the rail
 * is a convenience, not the gate.
 */

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {useSWRConfig} from 'swr';
import useSWR from 'swr';
import {
  pvAuth, setCurrentOrg, rememberedOrg, readPvCsrf, PV_EXPIRES_KEY, PV_IDLE_KEY,
  type ConsoleContext, type ConsoleOrg, type ModuleKey,
} from '@/lib/provider/api';
import {PROVIDER_NAV, navActive, type NavIcon} from '@/lib/provider/nav';
import {pvRoutes} from '@/lib/provider/routes';
import {ChangePasswordDialog} from './ChangePassword';

const REFRESH_LEAD_SEC = 60;
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const RAIL_KEY = 'bravo_pv_rail_collapsed';

interface ProviderCtx {
  context: ConsoleContext;
  org: ConsoleOrg;
  orgId: string;
  isOwner: boolean;
  can: (...keys: ModuleKey[]) => boolean;
  signOut: () => void;
}

const Ctx = createContext<ProviderCtx | null>(null);

export function useProvider(): ProviderCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useProvider outside ProviderShell');
  return v;
}

const ic = {width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true};

const ICONS: Record<NavIcon, ReactNode> = {
  home:     <svg {...ic}><path d="M3 12 12 3l9 9"/><path d="M5 10v10h14V10"/></svg>,
  shield:   <svg {...ic}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  people:   <svg {...ic}><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.7.8 2.7 2.5 3 5.2"/></svg>,
  star:     <svg {...ic}><path d="m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z"/></svg>,
  car:      <svg {...ic}><path d="M5 17h14M6 17v2M18 17v2M3 13l2-6h14l2 6v4H3z"/><circle cx="7.5" cy="13.5" r="1"/><circle cx="16.5" cy="13.5" r="1"/></svg>,
  key:      <svg {...ic}><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/><path d="m17 3 1.5 1.5L21 2"/></svg>,
  chart:    <svg {...ic}><path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/></svg>,
};

function Splash({label}: {label: string}) {
  return (
    <div className="pv-splash">
      <div className="pv-spin"/>
      <div className="pv-splash-label">{label}</div>
    </div>
  );
}

function NoAccess({name, onSignOut}: {name: string | null; onSignOut: () => void}) {
  return (
    <div className="auth-page" style={{gridTemplateColumns: '1fr'}}>
      <main className="auth-main">
        <div className="auth-card">
          {/* eslint-disable-next-line @next/next/no-img-element -- static SVG logo */}
          <img src="/bravo-logo-light.svg" alt="Bravo Secure" width={132} height={95} style={{display: 'block', marginBottom: 24}}/>
          <h2 className="auth-title">No service provider access</h2>
          <p className="auth-desc">
            {name ? `${name}, this` : 'This'} account is not the owner or a manager of a service provider
            on Bravo Secure. If you work for an agency, ask its owner to make you a manager in the app,
            then sign in again.
          </p>
          <button className="btn btn-pri auth-submit" onClick={onSignOut}>Sign out</button>
        </div>
      </main>
    </div>
  );
}

export function ProviderShell({children}: {children: ReactNode}) {
  const path = usePathname() ?? '/';
  const {mutate} = useSWRConfig();
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);

  useEffect(() => {
    const ok = !!readPvCsrf();
    setHasSession(ok);
    if (!ok) window.location.replace(pvRoutes.login);
    try { setCollapsed(window.localStorage.getItem(RAIL_KEY) === '1'); } catch { /* ignore */ }
  }, []);

  const {data: context, error: ctxError} = useSWR<ConsoleContext>(
    hasSession ? ['pv', 'context'] : null, pvAuth.context, {refreshInterval: 120_000},
  );

  // Pick the agency: the remembered one if still valid, else the first.
  useEffect(() => {
    if (!context || context.orgs.length === 0) return;
    const want = orgId ?? rememberedOrg();
    const chosen = context.orgs.find(o => o.org_id === want) ?? context.orgs[0];
    if (chosen.org_id !== orgId) setOrgId(chosen.org_id);
    setCurrentOrg(chosen.org_id);
  }, [context, orgId]);

  const signOut = useCallback(() => {
    void mutate(() => true, undefined, {revalidate: false});
    void pvAuth.signOut().finally(() => window.location.replace(pvRoutes.login));
  }, [mutate]);

  // Silent refresh ahead of the access-cookie expiry.
  useEffect(() => {
    if (hasSession !== true) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (expiresAt: number) => {
      const delay = Math.max(expiresAt - Date.now() - REFRESH_LEAD_SEC * 1000, 1_000);
      timer = setTimeout(async () => {
        try {
          const {expiresIn} = await pvAuth.sessionRefresh();
          const next = Date.now() + expiresIn * 1000;
          window.sessionStorage.setItem(PV_EXPIRES_KEY, String(next));
          schedule(next);
        } catch { signOut(); }
      }, delay);
    };
    const raw = window.sessionStorage.getItem(PV_EXPIRES_KEY);
    schedule(raw ? Number(raw) : Date.now() + 15 * 60_000);
    return () => { if (timer) clearTimeout(timer); };
  }, [hasSession, signOut]);

  // Idle sign-out.
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (hasSession !== true) return;
    const fire = () => { window.sessionStorage.setItem(PV_IDLE_KEY, '1'); signOut(); };
    const reset = () => { if (idle.current) clearTimeout(idle.current); idle.current = setTimeout(fire, IDLE_TIMEOUT_MS); };
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'] as const;
    for (const e of events) window.addEventListener(e, reset, {passive: true});
    reset();
    return () => {
      for (const e of events) window.removeEventListener(e, reset);
      if (idle.current) clearTimeout(idle.current);
    };
  }, [hasSession, signOut]);

  const org = context?.orgs.find(o => o.org_id === orgId) ?? null;
  const value = useMemo<ProviderCtx | null>(() => {
    if (!context || !org) return null;
    const isOwner = org.role === 'owner';
    return {
      context, org, orgId: org.org_id, isOwner, signOut,
      can: (...keys) => isOwner || keys.some(k => org.modules.includes(k)),
    };
  }, [context, org, signOut]);

  if (hasSession !== true) return <Splash label="Loading…"/>;
  if (ctxError) {
    return <Splash label="Cannot reach Bravo Secure. Retrying…"/>;
  }
  if (!context) return <Splash label="Loading…"/>;
  if (context.orgs.length === 0) return <NoAccess name={context.user.display_name} onSignOut={signOut}/>;
  if (!value) return <Splash label="Loading…"/>;

  const name = context.user.display_name ?? 'Signed in';
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase() || 'BS';

  return (
    <Ctx.Provider value={value}>
      <div className="app-shell" data-rail={collapsed ? 'collapsed' : 'expanded'}>
        <nav className="rail" aria-label="Provider console">
          <div className="rail-head">
            <div className="rail-logo">
              {/* eslint-disable-next-line @next/next/no-img-element -- static SVG mark */}
              <img src="/bravo-mark-light.svg" alt="" width={22} height={17} aria-hidden="true"/>
            </div>
            <span className="rail-brand" style={{fontSize: 12, letterSpacing: 0}}>BRAVO PROVIDER</span>
            <button className="rail-toggle"
              onClick={() => { const n = !collapsed; setCollapsed(n); try { window.localStorage.setItem(RAIL_KEY, n ? '1' : '0'); } catch { /* ignore */ } }}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
              {collapsed ? '»' : '«'}
            </button>
          </div>
          <div className="rail-nav">
            {PROVIDER_NAV.map(g => {
              const items = g.items.filter(i => (i.ownerOnly ? value.isOwner : !i.modules || value.can(...i.modules)));
              if (items.length === 0) return null;
              return (
                <div key={g.label} className="rail-group-block">
                  <div className="rail-group"><span>{g.label}</span></div>
                  {items.map(i => {
                    const active = navActive(i.href, path);
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
              );
            })}
          </div>
          <div className="rail-sep"/>
        </nav>

        <header className="topbar">
          <div className="pv-org">
            <span className="pv-org-cap">Agency</span>
            {context.orgs.length > 1 ? (
              <select className="pv-org-select" value={value.orgId}
                aria-label="Agency"
                onChange={e => { setOrgId(e.target.value); setCurrentOrg(e.target.value); }}>
                {context.orgs.map(o => <option key={o.org_id} value={o.org_id}>{o.name || 'Unnamed agency'}</option>)}
              </select>
            ) : (
              <span className="pv-org-name">{value.org.name || 'Your agency'}</span>
            )}
            {value.org.department && <span className="pill">{value.org.department}</span>}
          </div>
          <div style={{flex: 1}}/>
          <div className="topbar-admin" style={{cursor: 'default'}}>
            <div className="topbar-admin-av">{initials}</div>
            <div>
              <div className="pv-user-name">{name}</div>
              <div className="pv-user-role">{value.isOwner ? 'Owner' : 'Manager'}</div>
            </div>
            <button onClick={() => setPwOpen(true)} title="Change password" className="pv-signout">Password</button>
            <button onClick={signOut} title="Sign out" className="pv-signout" style={{marginLeft: 6}}>Sign out</button>
          </div>
        </header>

        <main className="main-area" key={value.orgId}>
          {context.user.password_temporary && (
            <div className="pv-banner" role="status">
              <span>You are signed in with a temporary password from Bravo Secure. Choose your own now.</span>
              <button className="btn btn-sm btn-pri" onClick={() => setPwOpen(true)}>Change password</button>
            </div>
          )}
          {children}
        </main>
        <ChangePasswordDialog open={pwOpen} temporary={!!context.user.password_temporary} onClose={() => setPwOpen(false)}/>
      </div>
    </Ctx.Provider>
  );
}

/** A page section the signed-in manager was not granted. */
export function NotGranted({what}: {what: string}) {
  return (
    <div className="card" style={{padding: 28, maxWidth: 560}}>
      <h2 style={{margin: '0 0 8px', fontSize: 18}}>No access to {what}</h2>
      <p className="text-sm text-t3" style={{margin: 0, lineHeight: 1.6}}>
        Your agency owner decides what each manager can open. Ask them to turn on {what} for you
        under Managers in the provider console or the app.
      </p>
    </div>
  );
}
