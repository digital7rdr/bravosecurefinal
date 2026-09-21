'use client';

import Link from 'next/link';
import {useEffect, useState} from 'react';
import {BravoMap, type BravoMarker} from '@/components/BravoMapLazy';
import {useMissions} from '@/lib/api';
import {PageHeader} from '@/components/PageHeader';
import {TruncationNotice} from '@/components/TruncationNotice';
import {LITE_SERVICES, EXECUTIVE_SERVICE, routes, missionHref} from '@/lib/routes';
import type {BookingProduct} from '@/features/bookings/BookingsList';

/**
 * E2E-42 — the ACTIVE tab's server cap. `MissionService.listActive` passes a
 * hard-coded 200 and ignores the `limit` query param entirely
 * (mission.service.ts:137-139), so unlike the completed tab there is nothing
 * for a LOAD MORE to raise. The cap is surfaced instead of hidden; raising it
 * is a server change (offset paging on /ops/missions).
 */
const ACTIVE_CAP = 200;

function shortRoute(pickup: string | null, dropoff: string | null): string {
  const p = pickup?.split(',')[0]?.trim() ?? '—';
  const d = dropoff?.split(',')[0]?.trim() ?? '—';
  return `${p} → ${d}`;
}

// OC-07 — the overview showed every dead feed as a healthy dot ('eta: live')
// while /live/[id] had proper LOST SIGNAL treatment. Same thresholds as the
// detail page (90 s stale / 300 s lost); client clock is fine at these spans
// (the detail page keeps the skew-corrected version).
const TRACKED_STATUSES = new Set(['CREWED', 'DISPATCHED', 'PICKUP', 'LIVE', 'SOS']);
type FixState = 'live' | 'stale' | 'lost' | 'none';
function fixInfo(status: string, updatedAt: string | null, hasFix: boolean): {state: FixState; label: string} {
  if (!TRACKED_STATUSES.has(status) || !hasFix) return {state: 'none', label: '—'};
  if (!updatedAt) return {state: 'live', label: 'LIVE'};
  const age = Date.now() - new Date(updatedAt).getTime();
  if (age > 300_000) return {state: 'lost', label: `LOST ${Math.max(1, Math.floor(age / 60_000))}m`};
  if (age > 90_000) return {state: 'stale', label: `STALE ${Math.floor(age / 1000)}s`};
  return {state: 'live', label: 'LIVE'};
}

/**
 * IA-01/IA-03 — the missions board, scoped to ONE product.
 *
 * Lite transfers and Executive details are different jobs with different
 * mechanics (waypoints vs hourly check-ins), and an operator watching one has
 * no use for the other in the same table. Same component, server-side scope.
 */
export function MissionsList({product}: {product: BookingProduct}) {
  const isExec = product === 'executive';
  const [tab, setTab] = useState<'active' | 'completed'>('active');
  // DC-09 — the completed tab was silently capped at 50 with no way to see
  // older missions; load-more raises the server limit (max 500).
  const [closedLimit, setClosedLimit] = useState(50);
  // OP-13 — the search box only filtered the loaded window (IS-12): a real
  // mission outside it read as "no results". The debounced query now goes to
  // the server as `q` (id / client / CPO name); the client filter below only
  // narrows the returned rows further (it also matches email and route).
  const service = isExec ? EXECUTIVE_SERVICE : LITE_SERVICES.join(',');
  const [query, setQuery] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), 400);
    return () => clearTimeout(t);
  }, [query]);
  const {data: missions, isLoading, error} = useMissions({
    status: tab,
    limit: tab === 'completed' ? closedLimit : undefined,
    q: debouncedQ || undefined,
    // IA-03 — product scope, applied server-side.
    service,
  });

  // A dead feed stops changing the SWR payload, so ages only advance if
  // something re-renders — same load-bearing tick as /live/[id].
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const all = (missions ?? []).map(m => ({
    id: m.id,
    short_code: m.short_code,
    booking_id: m.booking_id,
    client_name: m.client_display_name ?? '—',
    client_email: m.client_email ?? '',
    region: m.region_code ?? '—',
    route: shortRoute(m.pickup_address, m.dropoff_address),
    pickup: m.pickup_address ?? '—',
    dropoff: m.dropoff_address ?? '—',
    crew: '—',
    vehicle: m.vehicle_plate ?? '—',
    fix: fixInfo(m.status, m.updated_at, m.current_lat != null),
    status: m.status,
    lat: m.current_lat ?? undefined,
    lng: m.current_lng ?? undefined,
  }));

  const q = query.trim().toLowerCase();
  const rows = q
    ? all.filter(r =>
        r.client_name.toLowerCase().includes(q) ||
        r.client_email.toLowerCase().includes(q) ||
        r.short_code.toLowerCase().includes(q) ||
        r.booking_id.toLowerCase().includes(q) ||
        r.pickup.toLowerCase().includes(q) ||
        r.dropoff.toLowerCase().includes(q),
      )
    : all;

  const markers: BravoMarker[] = rows
    .filter(r => r.lat != null && r.lng != null)
    .map(r => ({
      id: r.id,
      lat: r.lat as number,
      lng: r.lng as number,
      label: r.fix.state === 'lost'
        ? `${r.short_code ?? r.id} · LOST SIGNAL ${r.fix.label.replace('LOST ', '')}`
        : `${r.short_code ?? r.id} · ${r.status}`,
      type: r.status === 'SOS' ? 'sos' as const
        : r.fix.state === 'lost' ? 'standby' as const
        : 'live' as const,
    }));

  const sosCount = all.filter(r => r.status === 'SOS').length;
  const activeCount = all.length;

  return (
    <>
      <PageHeader
        title={isExec ? 'Executive Details & Check-ins' : 'Lite Missions'}
        subtitle={isExec
          ? 'Live on-site protection details. Progress is the hourly check-in record, not waypoints.'
          : 'Live transfers with GPS tracking, waypoints and route control.'}
        badges={<>
          <span className="pill pill-live">● {activeCount} ACTIVE</span>
          {sosCount > 0 && <span className="pill pill-err">⚠ {sosCount} SOS</span>}
        </>}
        actions={
          <Link
            href={isExec ? routes.lite.missions : routes.executive.missions}
            className="btn btn-sm btn-ghost">
            {isExec ? 'LITE MISSIONS →' : 'EXECUTIVE DETAILS →'}
          </Link>
        }
      />

      {/* Issue 44 — the page-local SOS banner is gone: SosAlertBar in the Shell
          now carries it on EVERY page, and reads unresolved `sos_events` rather
          than filtering `missions.status`, so it also catches the mission-less
          client and VBG panics this banner could never see. Two stacked red
          bars would only compete with each other. The head pill above stays —
          it counts the mission list this page is showing. */}

      <div style={{display:'grid', gridTemplateColumns:'1fr 340px', gap:12, flex:1, minHeight:0}}>
        {/* Map (Mapbox) */}
        <div className="card" style={{overflow:'hidden', position:'relative'}}>
          <BravoMap
            markers={markers}
            center={[55.17, 25.12]}
            zoom={10}
            style={{position:'absolute', inset:0}}
          />
        </div>

        {/* Missions panel */}
        <div className="card" style={{display:'flex', flexDirection:'column', overflow:'hidden'}}>
          <div className="card-header">
            <div className="card-header-title"><span className="bar"/>{tab === 'active' ? 'Active Missions' : 'Completed Missions'}</div>
            <div className="card-header-act" title={debouncedQ ? 'The query is sent to the server — results are not limited to the rows already loaded' : undefined}>
              {debouncedQ ? `${rows.length} MATCH · SEARCHING ALL RECORDS`
                : q ? `${rows.length} / ${all.length}`
                : `${all.length} ${tab === 'active' ? 'LIVE' : 'CLOSED'}`}
            </div>
          </div>
          {/* Active / Completed tab switch */}
          <div style={{display:'flex', borderBottom:'1px solid var(--bd-2)'}}>
            {(['active','completed'] as const).map(k => (
              <button
                key={k}
                onClick={() => { setTab(k); setQuery(''); }}
                style={{
                  flex:1, padding:'8px 0',
                  background: tab === k ? 'var(--surf-3)' : 'transparent',
                  color:      tab === k ? 'var(--tx-1)'  : 'var(--tx-3)',
                  border:'none',
                  borderBottom: tab === k ? `2px solid ${k === 'active' ? 'var(--act)' : 'var(--ok)'}` : '2px solid transparent',
                  fontFamily:'var(--font-mono)', fontSize:10.5, fontWeight:700, letterSpacing:1.2,
                  textTransform:'uppercase', cursor:'pointer',
                }}>
                {k === 'active' ? 'Active' : 'Completed'}
              </button>
            ))}
          </div>
          <div style={{padding:'10px 12px', borderBottom:'1px solid var(--bd-2)'}}>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search all missions — client, short code, route…"
              style={{
                width:'100%', height:32, borderRadius:6,
                background:'var(--surf-3)', border:'1px solid var(--bd-2)',
                padding:'0 10px', color:'var(--tx-1)',
                fontFamily:'var(--font-mono)', fontSize:11, outline:'none',
              }}
            />
          </div>
          <div style={{flex:1, overflowY:'auto'}}>
            {isLoading && !missions && (
              <div style={{padding:24,color:'var(--tx-3)',fontSize:11.5,textAlign:'center'}}>Loading…</div>
            )}
            {error && (
              <div style={{padding:24,color:'var(--err)',fontSize:11.5,textAlign:'center'}}>Failed to load missions.</div>
            )}
            {!isLoading && !error && rows.length === 0 && (
              <div style={{padding:24,color:'var(--tx-3)',fontSize:11.5,textAlign:'center'}}>
                {q ? `No missions match "${query}".` : 'No active missions.'}
              </div>
            )}
            {rows.map(m => (
              <Link key={m.id} href={missionHref({id: m.id, service})} style={{textDecoration:'none', display:'block'}}>
                <div style={{padding:'12px 14px', borderBottom:'1px solid var(--bd-2)', cursor:'pointer'}}>
                  <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                    <span style={{fontFamily:'var(--font-mono)', fontSize:10.5, color:'var(--acc)', fontWeight:700}}>
                      {m.short_code} · {m.region}
                    </span>
                    <span className={`pill ${
                      m.status === 'SOS'       ? 'pill-err pill-live' :
                      m.status === 'COMPLETED' ? 'pill-ok' :
                      m.status === 'ABORTED'   ? 'pill-err' :
                      'pill-act'
                    }`}>● {m.status}</span>
                  </div>
                  <div style={{fontFamily:'var(--font-sans)', fontSize:13, color:'var(--tx-1)', fontWeight:700, marginTop:6}}>
                    {m.client_name}
                  </div>
                  {/* Audit PAGE-15 — client email dropped from the list row (was
                      plaintext + unaudited, and can't host a reveal button inside
                      the row-wide <Link>). It stays masked + audited on the
                      mission detail page. */}
                  <div style={{fontFamily:'var(--font-mono)', fontSize:10.5, color:'var(--tx-2)', marginTop:5, lineHeight:1.4}}>
                    {m.route}
                  </div>
                  <div style={{fontFamily:'var(--font-mono)', fontSize:9.5, color:'var(--tx-3)', display:'flex', gap:12, marginTop:6}}>
                    <span><b style={{color:'var(--tx-2)'}}>{m.vehicle}</b></span>
                    <span>GPS <b style={{
                      color: m.fix.state === 'lost' ? 'var(--err)'
                        : m.fix.state === 'stale' ? 'var(--warn, #F5A524)'
                        : m.status === 'SOS' ? 'var(--err)' : 'var(--glow)',
                    }}>{m.fix.label}</b></span>
                  </div>
                </div>
              </Link>
            ))}
            {tab === 'completed' && !isLoading && !error && all.length >= closedLimit && closedLimit < 500 && (
              <div style={{padding:'10px 0', textAlign:'center'}}>
                <button className="btn btn-sm btn-ghost" onClick={() => setClosedLimit(l => Math.min(l + 100, 500))}>
                  LOAD MORE ({all.length} loaded)
                </button>
              </div>
            )}
            {/* E2E-42 — the two caps this panel can hit. The completed tab's
                LOAD MORE above stops at 500 and then said nothing; the active
                tab never had one at all. Both now announce themselves. The
                counts are `all`, not `rows`: a client-side search narrowing
                the window does not mean the server truncated. */}
            {tab === 'active' && !isLoading && !error && (
              <TruncationNotice
                shown={all.length}
                cap={ACTIVE_CAP}
                noun={isExec ? 'active details' : 'active missions'}
                hint="Filter by region or search to narrow the board."
              />
            )}
            {tab === 'completed' && !isLoading && !error && (
              <TruncationNotice
                shown={all.length}
                cap={500}
                noun="closed missions"
                hint="Search to reach older records — the query runs server-side."
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
