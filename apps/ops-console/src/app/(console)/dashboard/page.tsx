'use client';

/**
 * IA-10 — the dashboard is segmented by BUSINESS, not by table.
 *
 * It used to show one flat KPI row in which `pending_approval` silently mixed
 * Lite and Executive bookings, Secure Pro arrived as two bolted-on counts, and
 * Enterprise had no number at all. An operator could not answer "what is
 * waiting on me, in which business?" — the first question of a shift.
 *
 * Every tile is a link into the section list with the filter already applied;
 * a number nobody can act on is noise.
 */

import type {ReactNode} from 'react';
import Link from 'next/link';
import {BravoMap} from '@/components/BravoMapLazy';
import {useDashboard, useMissions, useBookings, useOpsMe} from '@/lib/api';
import {formatDateTimeShortUtc} from '@/lib/datetime';
import {PageHeader} from '@/components/PageHeader';
import {KpiTile, KpiRow} from '@/components/SectionLanding';
import {LITE_SERVICES, routes, bookingHref} from '@/lib/routes';
import {canActInDomain, type AdminDomain} from '@/lib/rbac';

export default function Dashboard() {
  // OP-15 — share the Shell's key (['dashboard', admin region]) so the
  // endpoint is polled once per tab; a regional admin's board is scoped to
  // their region like their rail badges, a global admin's stays 'all'.
  const {data: me} = useOpsMe();
  const {data: dash, error: dashErr} = useDashboard(me?.admin.region);
  const {data: missions} = useMissions({status: 'active'});
  const {data: pending} = useBookings({status: 'PENDING_OPS', service: LITE_SERVICES.join(',')});

  const live = dashErr === undefined && dash !== undefined;
  const kpis = dash?.kpis;
  const activity = dash?.activity ?? [];
  const lite = kpis?.lite;
  const exec = kpis?.executive;
  const ent = kpis?.enterprise;

  const approvals = (pending ?? []).slice(0, 6);

  // Each admin level sees the businesses it works in (the rail and the
  // server's domain guard already do this; the board follows them). Nothing
  // renders until /ops/me has answered, so a Risk Admin never sees a flash
  // of operations tiles.
  const role = me?.admin.role;
  const can = (d: AdminDomain) => canActInDomain(role, d);
  const ops = can('operations'), comms = can('communication'), risk = can('risk');

  // Only live missions with a GPS lock become markers. Explicit null checks —
  // a fix at exactly 0/0 is a valid coordinate.
  const markers = (missions ?? [])
    .filter(m => m.current_lat != null && m.current_lng != null)
    .map(m => ({
      id: m.id,
      lat: m.current_lat as number,
      lng: m.current_lng as number,
      label: `${m.short_code} · ${m.status}`,
      type: m.status === 'SOS' ? 'sos' as const : 'live' as const,
    }));

  return (
    <>
      <PageHeader
        title="Today at a Glance"
        subtitle="What is waiting on ops right now, per business. Every tile opens the list it counts."
        badges={<>
          <span className="pill pill-live">● Live</span>
          <span className="pill">{live ? 'API online' : 'API offline'}</span>
        </>}
      />

      {/* ── Lite ─────────────────────────────────────────────────────── */}
      {ops && <SectionStrip title="Lite · Secure Transfer" href={routes.lite.root} columns={5}>
        <KpiTile
          label="Waiting on ops" value={lite?.waiting ?? kpis?.pending_approval ?? 0}
          href={routes.lite.bookings} tone="warn" urgent={(lite?.waiting ?? 0) > 0}
          sub="pending · no-provider · no-show"
        />
        <KpiTile label="Dispatching" value={lite?.dispatching ?? 0} href={routes.lite.dispatch} tone="info" />
        <KpiTile label="Live missions" value={lite?.live ?? 0} href={routes.lite.missions} tone="act" />
        <KpiTile label="Open jobs" value={kpis?.open_jobs ?? 0} href={routes.lite.jobs} tone="info" />
        <KpiTile
          label="GMV today" value={(lite?.gmv_today_bc ?? kpis?.gmv_today_bc ?? 0).toLocaleString()}
          href={routes.finance.ledger} sub="BC"
        />
      </SectionStrip>}

      {/* ── Executive Protection ─────────────────────────────────────── */}
      {ops && <SectionStrip title="Executive Protection" href={routes.executive.root} columns={4}>
        <KpiTile
          label="Waiting on ops" value={exec?.waiting ?? 0}
          href={routes.executive.bookings} tone="warn" urgent={(exec?.waiting ?? 0) > 0}
        />
        <KpiTile
          label="Starting in 24h" value={exec?.upcoming_24h ?? 0}
          href={routes.executive.bookings} tone="info" sub="approved or confirmed"
        />
        <KpiTile label="Live details" value={exec?.live ?? 0} href={routes.executive.missions} tone="act" />
        <KpiTile
          label="GMV today" value={(exec?.gmv_today_bc ?? 0).toLocaleString()}
          href={routes.finance.ledger} sub="BC"
        />
      </SectionStrip>}

      {/* ── Secure Pro + Enterprise + Safety ─────────────────────────── */}
      {(() => {
        const tiles: ReactNode[] = [];
        const parts: string[] = [];
        if (ops) {
          parts.push('Secure Pro');
          tiles.push(
            <KpiTile key="pro-apps"
              label="Pro applications" value={kpis?.pro_pending ?? 0}
              href={routes.pro.applications} tone="warn" urgent={(kpis?.pro_pending ?? 0) > 0}
              sub="new or revision requested"
            />,
            <KpiTile key="pro-req"
              label="Pro date requests" value={kpis?.pro_requests ?? 0}
              href={routes.pro.assignments} tone="warn" sub="awaiting officers"
            />,
          );
        }
        if (comms) {
          parts.push('Enterprise');
          tiles.push(
            <KpiTile key="ent-join"
              label="Enterprise join requests" value={ent?.waiting ?? 0}
              href={routes.enterprise.joinRequests} tone="info"
            />,
            <KpiTile key="ent-inc"
              label="Critical incidents 24h" value={ent?.critical_incidents_24h ?? 0}
              href={routes.enterprise.incidents} tone="err" urgent={(ent?.critical_incidents_24h ?? 0) > 0}
            />,
          );
        }
        if (risk) {
          parts.push('Safety');
          tiles.push(
            <KpiTile key="sos"
              label="SOS active" value={kpis?.sos_active ?? 0}
              href={routes.safety.sos} tone="err" urgent={(kpis?.sos_active ?? 0) > 0}
            />,
          );
        }
        if (ops) {
          tiles.push(
            <KpiTile key="agents"
              label="Agents on duty" value={`${kpis?.agents_on_duty ?? 0}`}
              sub={`of ${kpis?.agents_total ?? 0} total`} href={routes.people.agents}
            />,
          );
        }
        if (tiles.length === 0) return null;
        const href = ops ? routes.pro.root : comms ? routes.enterprise.joinRequests : routes.safety.sos;
        return (
          <SectionStrip title={parts.join(' · ')} href={href} columns={Math.max(tiles.length, 3)}>
            {tiles}
          </SectionStrip>
        );
      })()}

      <div className="dash-grid" style={ops ? undefined : {gridTemplateColumns: '1.4fr 1fr'}}>
        {ops && <div className="card" style={{display: 'flex', flexDirection: 'column', overflow: 'hidden'}}>
          <div className="card-header">
            <div className="card-header-title"><span className="bar" />Lite Approval Queue</div>
            <Link href={routes.lite.bookings} className="card-header-act">
              View all ({lite?.pending_approval ?? kpis?.pending_approval ?? 0}) →
            </Link>
          </div>
          <div style={{flex: 1, overflow: 'auto'}}>
            {approvals.length === 0 && (
              <div className="q-empty">No Lite bookings awaiting approval.</div>
            )}
            {approvals.map(a => (
              <Link key={a.id} href={bookingHref(a)} style={{textDecoration: 'none', display: 'block'}}>
                <div className="aq-row">
                  <div className="aq-id">
                    {a.id.slice(-12).toUpperCase()}
                    <span className="aq-id-sub">{formatDateTimeShortUtc(a.created_at)}</span>
                  </div>
                  <div>
                    <div className="aq-client">{a.client_name ?? a.region_label}</div>
                    <div className="aq-route">
                      <b>{(a.pickup_address ?? '').split(',')[0]}</b> → <b>{(a.dropoff_address ?? '—').split(',')[0]}</b>
                    </div>
                    <div className="aq-meta">
                      <span>CPO×{a.cpo_count} · {Number(a.total_eur).toLocaleString()} BC</span>
                    </div>
                  </div>
                  <div className="aq-actions">
                    <div className="aq-ico" title="Open">
                      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                        <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
                      </svg>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>}

        <div className="card" style={{display: 'flex', flexDirection: 'column', overflow: 'hidden'}}>
          <div className="card-header">
            <div className="card-header-title"><span className="bar" />Live Ops Map</div>
            <div className="card-header-act">
              {kpis?.active_missions ?? 0} active · {kpis?.sos_active ?? 0} SOS
            </div>
          </div>
          <BravoMap markers={markers} center={[55.272, 25.208]} zoom={11} followUser style={{flex: 1}} />
        </div>

        <div className="card" style={{display: 'flex', flexDirection: 'column', overflow: 'hidden'}}>
          <div className="card-header">
            <div className="card-header-title"><span className="bar" />Activity</div>
            {/* N-35 — a poll, not a live stream; label it honestly. */}
            <div className="card-header-act">Recent</div>
          </div>
          <div style={{flex: 1, overflow: 'auto'}}>
            {activity.length === 0 && <div className="q-empty">No recent activity.</div>}
            {activity.map(ev => (
              <div key={ev.id} className={`af-row${ev.severity === 'err' ? ' sos' : ''}`}>
                <div className="af-ts">{formatDateTimeShortUtc(ev.created_at)}</div>
                <div className="af-msg">{ev.message}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function SectionStrip({
  title, href, columns, children,
}: {title: string; href: string; columns: number; children: ReactNode}) {
  return (
    <section style={{marginBottom: 6}}>
      <div className="dash-strip-head">
        <span>{title}</span>
        <Link href={href} className="dash-strip-link">View section →</Link>
      </div>
      <KpiRow columns={columns}>{children}</KpiRow>
    </section>
  );
}
