'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {SkeletonRows} from '@/components/SkeletonRows';
import {opsApi, POLL_DASH, type DispatchRequestRow} from '@/lib/api';
import {usePagedList} from '@/lib/usePagedList';
// OP-14 — the server's default page (max 200); the list used to stop at the
// newest 50 with no way to see older requests. 500 matches the other lists' cap.
const PAGE = 50;
const MAX_ROWS = 500;
const idOf = (r: DispatchRequestRow) => r.booking_id;
import {routes} from '@/lib/routes';

const FILTERS: Array<{label: string; value?: string}> = [
  {label: 'All'},
  {label: 'Dispatching', value: 'DISPATCHING'},
  {label: 'Confirmed', value: 'CONFIRMED'},
  {label: 'Live', value: 'LIVE'},
  {label: 'Completed', value: 'COMPLETED'},
  {label: 'No provider', value: 'NO_PROVIDER'},
  {label: 'No-show', value: 'AGENCY_NO_SHOW'},
  {label: 'Cancelled', value: 'CANCELLED'},
];

function tone(s: string): string {
  if (s === 'CONFIRMED' || s === 'COMPLETED') { return 'ok'; }
  if (s === 'DISPATCHING') { return 'warn'; }
  if (s === 'LIVE') { return 'live'; }
  if (s === 'NO_PROVIDER' || s === 'AGENCY_NO_SHOW' || s === 'CANCELLED') { return 'err'; }
  return 'info';
}

function shortTs(ts: string | null): string {
  if (!ts) { return '—'; }
  return ts.replace('T', ' ').slice(0, 16).replace(/-/g, '/');
}

export default function DispatchInspectorPage() {
  const router = useRouter();
  const [status, setStatus] = useState<string | undefined>(undefined);
  const {rows, error, isLoading, isLoadingMore, hasMore, loadMore, lastPageFull} = usePagedList<DispatchRequestRow>({
    key: ['dispatch-requests', status ?? 'all'],
    pageSize: PAGE,
    maxRows: MAX_ROWS,
    fetchPage: ({limit, offset}) => opsApi.dispatchRequests({status, limit, offset}),
    idOf,
    swr: {refreshInterval: POLL_DASH},
  });

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-crumbs">Ops · Dispatch Inspector</div>
          <h2>Auto-Dispatch Requests</h2>
        </div>
        <div className="page-head-right">
          <span className="pill">{error ? 'API OFFLINE' : `${rows.length} SHOWN`}</span>
        </div>
      </div>

      <div style={{display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14}}>
        {FILTERS.map(f => {
          const active = status === f.value;
          return (
            <button key={f.label} onClick={() => setStatus(f.value)}
              style={{
                cursor: 'pointer', fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: 0.3,
                padding: '5px 11px', borderRadius: 999,
                border: `1px solid ${active ? 'var(--act)' : 'var(--bd-2)'}`,
                background: active ? 'rgba(30,136,255,0.14)' : 'transparent',
                color: active ? 'var(--tx-1)' : 'var(--tx-3)',
              }}>
              {f.label}
            </button>
          );
        })}
      </div>

      <div className="dt-wrap" style={{flex: 1, overflow: 'auto'}}>
        <table className="dt">
          <thead>
            <tr>
              <th style={{width: 160}}>Booking #</th>
              <th style={{width: 150}}>Status</th>
              <th>Region</th>
              <th style={{width: 80}}>Crew</th>
              <th style={{width: 70}}>Offers</th>
              <th>Accepting agency</th>
              <th style={{width: 110}}>Escrow</th>
              <th style={{width: 150}}>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={8}><SkeletonRows rows={8} /></td></tr>
            )}
            {error && (
              <tr><td colSpan={8} style={{padding: 24, textAlign: 'center', color: 'var(--err)'}}>
                Failed to load · {String((error as Error).message)}
              </td></tr>
            )}
            {!isLoading && !error && rows.length === 0 && (
              <tr><td colSpan={8} style={{padding: 24, textAlign: 'center', color: 'var(--tx-3)'}}>
                No dispatch requests yet.
              </td></tr>
            )}
            {rows.map(r => (
              <tr key={r.booking_id} style={{cursor: 'pointer'}}
                  onClick={() => router.push(routes.lite.dispatchRequest(r.booking_id))}>
                <td className="dt-idcell">{r.booking_id.slice(-12).toUpperCase()}</td>
                <td><span className={`pill pill-${tone(r.status)}`}>● {r.status.replace(/_/g, ' ')}</span></td>
                <td><span className="dt-route">{r.region_label} · {r.region_code}{r.armed_required ? ' · armed' : ''}</span></td>
                <td><span className="dt-crew">{r.crew_count}/{r.cpo_count}</span></td>
                <td><span className="dt-crew">{r.offers_count}</span></td>
                <td><span className="dt-route">{r.accepting_agency_name ?? r.accepting_agency_call_sign ?? '—'}</span></td>
                <td><span className="dt-crew">{r.escrow_status ?? '—'}</span></td>
                <td><span className="dt-when">{shortTs(r.last_activity_at)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* Truncation is stated, never silent: a full page means the server
            may hold more, and the cap is named when it has been reached. */}
        {!error && lastPageFull && (
          <div style={{padding: '10px 0', textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--tx-3)'}}>
            {hasMore ? (
              <button className="btn btn-sm btn-ghost" disabled={isLoadingMore} onClick={loadMore}>
                {isLoadingMore ? 'LOADING…' : `LOAD MORE (${rows.length} loaded — newest first, more on server)`}
              </button>
            ) : rows.length >= MAX_ROWS ? (
              <span>SHOWING THE NEWEST {rows.length} — LIST CAPPED AT {MAX_ROWS}; NARROW BY STATUS TO SEE OLDER REQUESTS</span>
            ) : (
              <span>SHOWING THE NEWEST {rows.length} — THE SERVER RETURNED NO FURTHER ROWS</span>
            )}
          </div>
        )}
      </div>
    </>
  );
}
