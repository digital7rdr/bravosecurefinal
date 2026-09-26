'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { authApi, useActivity, useDashboard, useOpsMe, useSosEvents, clearSession, POLL_DASH } from '@/lib/api';
import { useFreshness } from '@/lib/freshness';
import { ROLE_LABEL, canActInDomain, hasRole, type AdminRole } from '@/lib/rbac';
import { NAV_GROUPS, isNavItemActive, type NavBadgeKey } from '@/lib/nav';
import { routes } from '@/lib/routes';
import { useMessenger } from './messenger/MessengerProvider';
import NotificationBell from './NotificationBell';
import OpsNotifier from './OpsNotifier';
import SosAlertBar from './SosAlertBar';

// Audit fix 4.1 — refresh the access cookie this many seconds BEFORE it
// expires so a long-running request doesn't race the rotation. 60s gives
// plenty of slack on a 15-min default access TTL.
const REFRESH_LEAD_SEC = 60;

// Audit fix 4.1 — idle timeout. Q5 decision: 15 minutes of no activity
// (mouse/keyboard/touch/visibilitychange) → logout. Reset on any input
// event so an admin reading a long card doesn't get bounced mid-glance.
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

const RAIL_COLLAPSED_KEY = 'bravo_ops_rail_collapsed';

function Splash({label}: {label: string}) {
  return (
    <div style={{
      minHeight:'100vh', background:'var(--bg)',
      display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:14,
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: '50%',
        border: '2.5px solid var(--surf-3)', borderTopColor: 'var(--acc)',
        animation: 'splashspin 0.9s linear infinite',
      }}/>
      <div style={{
        fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--tx-3)',
        letterSpacing: 1.5, fontWeight: 700, textTransform: 'uppercase',
      }}>{label}</div>
      <style>{`@keyframes splashspin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// OP-11 / OC-17 — LIVE / STALE / OFFLINE. Fed by the global SWRConfig
// onSuccess/onError hooks (lib/freshness.ts); ticks once a second only while
// mounted. STALE = newest success older than 3 dashboard polls; OFFLINE =
// three consecutive failures with no success since.
const STALE_AFTER_MS = 3 * POLL_DASH;
const OFFLINE_AFTER_FAILURES = 3;

function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}S`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}M`;
  return `${Math.floor(m / 60)}H`;
}

function FreshnessPill() {
  const f = useFreshness();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (f.consecutiveFailures >= OFFLINE_AFTER_FAILURES) {
    return (
      <span className="pill pill-err" title="Every recent request failed — what you see may be stale">
        OFFLINE · {f.consecutiveFailures} FAILURES
      </span>
    );
  }
  if (f.lastOkAt == null) {
    return <span className="pill" title="Waiting for the first successful fetch">SYNC · CONNECTING</span>;
  }
  const age = now - f.lastOkAt;
  if (age > STALE_AFTER_MS) {
    return (
      <span className="pill pill-warn" title="No successful refresh for longer than three poll cycles">
        STALE · LAST OK {ago(age)} AGO
      </span>
    );
  }
  return <span className="pill pill-ok" title="Data refreshed by the polling hooks">LIVE · UPDATED {ago(age)} AGO</span>;
}

function UtcClock() {
  const [time, setTime] = useState('');
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const d = now.toISOString().slice(0, 10);
      const t = now.toUTCString().slice(17, 25);
      setTime(`${d}  ·  ${t} UTC`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return <div className="topbar-clock">{time}</div>;
}

export function Shell({ children }: { children: ReactNode }) {
  const path   = usePathname();
  const router = useRouter();
  const [hasToken, setHasToken] = useState<boolean | null>(null);

  // Collapsible rail — persisted so an admin's choice survives navigation
  // and reloads. Read in an effect (not initial state) to avoid an SSR /
  // hydration mismatch; a brief expanded→collapsed flip on first paint is
  // acceptable.
  const [railCollapsed, setRailCollapsed] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setRailCollapsed(window.localStorage.getItem(RAIL_COLLAPSED_KEY) === '1');
  }, []);
  const toggleRail = useCallback(() => {
    setRailCollapsed(c => {
      const next = !c;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(RAIL_COLLAPSED_KEY, next ? '1' : '0');
      }
      return next;
    });
  }, []);

  // Audit fix 0.4 — the cookie session is httpOnly so JS can't probe for
  // it directly. The CSRF cookie IS readable, so we use its presence as
  // a "we're logged in" hint. The middleware handles the redirect on
  // server-side requests; this client-side check just avoids flashing
  // the dashboard before /ops/me bounces us.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const hasCsrfCookie = /(?:^|;\s*)bravo_ops_csrf=/.test(document.cookie);
    if (!hasCsrfCookie) {
      router.replace(routes.login);
      setHasToken(false);
    } else {
      setHasToken(true);
    }
  }, [router]);

  // SWR fetches /ops/me — if the request 401s, fetchJson auto-redirects.
  const {data: me} = useOpsMe();
  const {wipe: wipeMessenger} = useMessenger();
  const {mutate} = useSWRConfig();

  const logout = useCallback(() => {
    // Audit fix 4.1 / 4.7 + audit P0-W5 — coordinated client-side teardown:
    //   1. Wipe the messenger runtime AND its IndexedDB vault. The
    //      previous version only `lock()`-ed (dropped the in-memory
    //      key), leaving the IDB-encrypted ratchet/messages on disk
    //      forever — a different admin signing in on the same browser
    //      saw the prior admin's encrypted state, and a stolen device
    //      retained the entire history at rest. `wipe()` deletes the
    //      bravo-messenger-<userId> database wholesale.
    //   2. clearSession() wipes the cookies server-side and clears the
    //      in-memory messenger ticket cache (#13).
    //   3. SWR cache invalidated globally so /ops/me + dashboard widgets
    //      don't briefly paint with the prior admin's data on next mount.
    //   4. Redirect to /login regardless of server-side failure.
    void wipeMessenger().catch(() => { /* logout always proceeds */ });
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem('bravo_ops_access_expires_at');
    }
    void mutate(() => true, undefined, {revalidate: false});
    // Hard navigation (not router.replace): a full document load tears
    // down the silent-refresh timer, idle timer, SWR cache and messenger
    // provider so none of them can resurrect the session after we've
    // cleared the cookies. A soft nav keeps the SPA — and its refresh
    // timer — alive, which is part of how sign-out "didn't take".
    void clearSession().finally(() => {
      if (typeof window !== 'undefined') window.location.replace(routes.login);
      else router.replace(routes.login);
    });
  }, [wipeMessenger, mutate, router]);

  // Audit fix 4.1 — silent token refresh. Schedules a refresh
  // REFRESH_LEAD_SEC before the access cookie expires. The refresh
  // endpoint reads the path-scoped httpOnly `bravo_ops_refresh` cookie
  // and rotates BOTH cookies, so on success we simply re-arm the timer
  // with the new expiry. On any failure we drop straight to logout —
  // there's no graceful retry, because by then the cookie is gone and
  // the next /ops/me will 401 anyway.
  useEffect(() => {
    if (hasToken !== true) return;
    if (typeof window === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function schedule(expiresAtMs: number) {
      const delay = Math.max(expiresAtMs - Date.now() - REFRESH_LEAD_SEC * 1000, 1_000);
      timer = setTimeout(async () => {
        try {
          const {expiresIn} = await authApi.sessionRefresh();
          const next = Date.now() + expiresIn * 1000;
          window.sessionStorage.setItem('bravo_ops_access_expires_at', String(next));
          schedule(next);
        } catch {
          logout();
        }
      }, delay);
    }

    const raw = window.sessionStorage.getItem('bravo_ops_access_expires_at');
    // If we don't know when the cookie expires (e.g. tab restored without
    // a fresh login), assume a 15-min ceiling and try to refresh now-ish.
    const initialExpiry = raw ? Number(raw) : Date.now() + 15 * 60_000;
    schedule(initialExpiry);
    return () => { if (timer) clearTimeout(timer); };
  }, [hasToken, logout]);

  // OC-02 — an idle logout during an active SOS would unmount the alert bar
  // and silence the alarm: the monitoring station disarming itself at the
  // worst moment. Same SWR key as SosAlertBar, so this adds no extra fetch.
  // B-818 — only a level that can work SOS polls it (the server refuses the
  // rest with domain_scope_violation; an error on every tick is not "no SOS").
  const meRole = me?.admin.role;
  const {data: sosRows} = useSosEvents('active', undefined, {isPaused: () => !canActInDomain(meRole, 'risk')});
  const sosActiveRef = useRef(false);
  sosActiveRef.current = (sosRows ?? []).some(r => !r.resolved_at);

  // Audit fix 4.1 — idle timeout. Any user activity resets the clock;
  // 15 min of nothing → logout. Listening on the window catches both the
  // ops-console pages and any nested iframes. visibilitychange fires
  // when the tab is hidden so we don't keep the timer alive in the
  // background (a stale tab shouldn't keep a session warm for an hour).
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (hasToken !== true) return;
    if (typeof window === 'undefined') return;

    function fire() {
      // OC-02 — defer, don't skip: re-check every minute so the logout still
      // lands once the SOS is resolved. Security posture is unchanged for
      // every idle session that is NOT holding a live emergency.
      if (sosActiveRef.current) {
        idleTimer.current = setTimeout(fire, 60_000);
        return;
      }
      // Surface the reason so the login page can show a soft notice.
      if (typeof window !== 'undefined') {
        window.sessionStorage.setItem('bravo_ops_idle_logout', '1');
      }
      logout();
    }

    function reset() {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(fire, IDLE_TIMEOUT_MS);
    }

    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'] as const;
    for (const e of events) window.addEventListener(e, reset, {passive: true});
    document.addEventListener('visibilitychange', reset);
    reset();

    return () => {
      for (const e of events) window.removeEventListener(e, reset);
      document.removeEventListener('visibilitychange', reset);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [hasToken, logout]);

  // Audit fix 4.6 — bell badge wired to unacked SOS count from the
  // dashboard endpoint (the most operationally urgent thing the badge
  // could carry — a paged admin who sees a "7" wants to know it isn't
  // marketing fluff). useDashboard already SWR-polls, no extra fetch.
  //
  // IMPORTANT: this hook MUST be declared BEFORE the conditional early
  // returns below — otherwise the first render (hasToken === null)
  // exits before this hook is called, and the next render
  // (hasToken === true) calls one more hook than the previous one →
  // React error #310 "Rendered more hooks than during the previous
  // render". The early returns belong after every hook has been
  // declared.
  // OP-15 — the SAME key the /dashboard page uses (['dashboard', region]),
  // so the endpoint is fetched once per tab. Both sides key on the admin's
  // own region: a regional OPS admin keeps region-scoped badges (the
  // pre-fix Shell behaviour) and a global ADMIN (no region) gets 'all'.
  const {data: dash} = useDashboard(me?.admin.region);
  const unackedSos = dash?.kpis?.sos_active ?? 0;
  // B-817 — the notification centre reads the 50-row feed (hidden-tab polling),
  // falling back to the dashboard's 10-row tail until the first fetch lands.
  const {data: feed} = useActivity(50);
  const activity = feed ?? dash?.activity ?? [];
  // IS-14 / IA-10 — "waiting on ops" counts ride the same dashboard poll (no
  // extra fetch) and are GROUP-level now: a badge on Lite / Executive / Secure
  // Pro / Enterprise / Safety tells an operator which business needs them
  // before they open anything. Every key is optional so a console deployed
  // ahead of the segmented-KPI backend simply shows no badge.
  const k = dash?.kpis;
  const navBadges: Partial<Record<NavBadgeKey, number>> = {
    lite:        k?.lite?.waiting ?? 0,
    executive:   k?.executive?.waiting ?? 0,
    // B-841 — one badge per QUEUE. Summed, the Applications item read "2" while
    // its own page said "NEW 0 · QUEUE CLEAR": the 2 was protection-date
    // requests, which are worked on /pro/assignments.
    pro:         k?.pro_pending ?? 0,
    proRequests: k?.pro_requests ?? 0,
    enterprise:  k?.enterprise?.waiting ?? 0,
    safety:      unackedSos,
  };

  if (hasToken === false) return <Splash label="Redirecting…"/>;
  if (hasToken === null)  return <Splash label="Loading…"/>;

  const callSign = me?.admin.call_sign ?? '…';
  const role     = me?.admin.role ?? '…';
  const initials = callSign.slice(0, 2).toUpperCase();

  // OC-12 — resolved once; an unknown role shows everything rather than an
  // empty rail while /ops/me is in flight.
  const roleKnown: AdminRole | undefined =
    // B-818 — recognise the four LEVELS too: an unknown role shows everything
    // (the OC-12 fallback), which for a real domain admin would be the wrong
    // rail; the server refuses the calls, but the rail must not promise them.
    role in ROLE_LABEL ? (role as AdminRole) : undefined;

  return (
    <div className="app-shell" data-rail={railCollapsed ? 'collapsed' : 'expanded'}>
      {/* Left rail */}
      <nav className="rail">
        <div className="rail-head">
          {/* The real brand mark (white + #0084FE wings), not a text tile.
              bravo-mark-light.svg is on the PUBLIC_ASSETS allowlist so it
              survives the auth gate; the tile keeps its size + accent glow. */}
          <div className="rail-logo">
            <img src="/bravo-mark-light.svg" alt="" width={22} height={17} aria-hidden="true" />
          </div>
          <span className="rail-brand">BRAVO OPS</span>
          <button
            className="rail-toggle"
            onClick={toggleRail}
            title={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {railCollapsed ? '»' : '«'}
          </button>
        </div>
        <div className="rail-nav">
          {NAV_GROUPS.map(g => {
            // OC-12 — drop items (and whole groups) below the operator's tier.
            // Until /ops/me resolves, show everything (a flash of extra items
            // beats a nav that pops in group by group).
            if (g.minRole && roleKnown && !hasRole(roleKnown, g.minRole)) return null;
            // B-818 — a domain admin's rail shows only its own domain (the server
            // guard refuses the rest anyway; this keeps the console honest).
            if (g.domain && roleKnown && !canActInDomain(roleKnown, g.domain)) return null;
            const items = g.items.filter(i => !i.minRole || !roleKnown || hasRole(roleKnown, i.minRole));
            if (items.length === 0) return null;
            // B-841 — the group number is what its VISIBLE items add up to. A
            // group-level key was a second mechanism for the same number, and
            // only one of the two moved when an item's queue did.
            const groupBadge = items.reduce((n, i) => n + (i.badgeKey ? navBadges[i.badgeKey] ?? 0 : 0), 0);
            return (
              <div key={g.key} className="rail-group-block">
                <div className="rail-group">
                  <span>{g.label}</span>
                  {groupBadge > 0 && <span className="rail-group-cnt">{groupBadge > 99 ? '99+' : groupBadge}</span>}
                </div>
                {items.map(n => {
                  const badge = n.badgeKey ? (navBadges[n.badgeKey] ?? 0) : 0;
                  const active = isNavItemActive(n, path ?? '');
                  return (
                    <Link key={n.href} href={n.href}
                      title={badge > 0 ? `${g.label} · ${n.label} · ${badge} waiting` : `${g.label} · ${n.label}`}
                      aria-current={active ? 'page' : undefined}
                      className={`rail-item ${active ? 'active' : ''}`}>
                      <span className="rail-ic">{n.icon}</span>
                      <span className="rail-label">{n.label}</span>
                      {badge > 0 && <span className="rail-badge">{badge > 99 ? '99+' : badge}</span>}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="rail-sep" />
      </nav>

      {/* Top bar */}
      <header className="topbar">
        {/* DC-17 — the fake ⌘K search box promised a global search that never
            existed; removed until a real one ships. Spacer keeps the layout. */}
        <div style={{flex: 1}} />
        <FreshnessPill />
        <UtcClock />
        {/* N-23/N-24 — real notification centre: a dropdown over the live
            activity feed with a per-browser unread watermark, plus the
            actionable (unacked AND unresolved) SOS count as a red sub-badge. */}
        <NotificationBell activity={activity} sosActive={unackedSos} />
        <div className="topbar-admin">
          <div className="topbar-admin-av">{initials}</div>
          <div>
            <div className="topbar-admin-name">{callSign}</div>
            <div className="topbar-admin-role">{role}</div>
          </div>
          <button
            onClick={logout}
            title="Sign out"
            style={{
              marginLeft: 10, padding: '6px 10px', borderRadius: 6,
              background: 'var(--surf-3)', border: '1px solid var(--bd-2)',
              color: 'var(--tx-2)', fontFamily: 'var(--font-mono)', fontSize: 9.5,
              letterSpacing: 1.2, fontWeight: 700, cursor: 'pointer',
            }}>
            SIGN OUT
          </button>
        </div>
      </header>

      {/* Page content */}
      <main className="main-area">
        {/* Issue 44 — the SOS banner used to live on /live only, so an operator
            on any other page saw nothing but a bell badge. An emergency alert
            that depends on which tab is open is not an alert. Persistent,
            audible, and not dismissible while the SOS is unresolved. */}
        <SosAlertBar />
        {/* B-817 — popups + browser overlays for every meaningful feed row,
            each one a link to the page that works it. Renders nothing. */}
        <OpsNotifier />
        {children}
      </main>
    </div>
  );
}
