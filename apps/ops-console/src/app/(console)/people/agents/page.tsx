'use client';

import { useState } from 'react';
import { SkeletonRows } from '@/components/SkeletonRows';
import Link from 'next/link';
import { opsApi, POLL_DASH, type AgentListRow } from '@/lib/api';
import { usePagedList } from '@/lib/usePagedList';
import { bcFromAed } from '@/lib/bc';
import {routes} from '@/lib/routes';

// OP-17 — page-index LOAD MORE (200 per page, 500 cap as before).
const PAGE = 200;
const MAX_ROWS = 500;
const idOf = (a: AgentListRow) => a.user_id;

const STATUS_FILTERS = ['ALL', 'ACTIVE', 'APPROVED', 'UNDER_REVIEW', 'SUBMITTED', 'REJECTED'] as const;
const TYPE_FILTERS   = ['ALL', 'cpo', 'company', 'transport'] as const;

const STATUS_CLASS: Record<string, string> = {
  ACTIVE: 'pill-ok',
  APPROVED: 'pill-info',
  UNDER_REVIEW: 'pill-warn',
  SUBMITTED: 'pill-warn',
  DOCS_PENDING: 'pill-warn',
  KYC_PENDING: 'pill-warn',
  PROFILE_COMPLETE: '',
  DRAFT: '',
  REJECTED: 'pill-err',
};

function regionLabel(a: AgentListRow): string {
  const on = a.coverage?.countries?.find(c => c.on);
  return on?.code ?? '—';
}

function callSign(a: AgentListRow): string {
  return a.call_sign ?? `AGT-${a.user_id.slice(0, 6).toUpperCase()}`;
}

function nameOf(a: AgentListRow): string {
  return a.display_name ?? a.email ?? a.phone ?? a.user_id.slice(0, 8);
}

function rateLabel(a: AgentListRow): string {
  if (!a.rate_aed_per_hour) return '—';
  // BC via the canonical platform ratio (350 AED ≡ 86 BC, pricing.service.ts).
  return `${bcFromAed(Number(a.rate_aed_per_hour))} BC`;
}

export default function Agents() {
  // DC-17 — the FILTER button was a dead placeholder; these chips drive the
  // real server-side ?status= / ?type= params. DC-09 — limit lifts the old
  // hardcoded 200-row cap via load-more.
  const [status, setStatus] = useState<string>('ALL');
  const [type, setType]     = useState<string>('ALL');
  const { rows: agents, isLoading, isLoadingMore, error, hasMore, loadMore } = usePagedList<AgentListRow>({
    key: ['agents', status, type],
    pageSize: PAGE,
    maxRows: MAX_ROWS,
    fetchPage: ({limit, offset}) => opsApi.listAgents({
      status: status === 'ALL' ? undefined : status,
      type:   type   === 'ALL' ? undefined : type,
      limit, offset,
    }),
    idOf,
    swr: {refreshInterval: POLL_DASH},
  });

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-crumbs">People  ·  Agents</div>
          <h2>Agents (CPOs)</h2>
          <div className="page-sub">
            Individual Close Protection Officers: onboarding, documents, KYC and mission history.
            Not the Secure Pro pool — that is the subset of approved officers assigned to plans.
          </div>
        </div>
        <div className="page-head-right" style={{display:'flex', gap:6, flexWrap:'wrap'}}>
          {STATUS_FILTERS.map(s => (
            <button key={s} className={`btn btn-sm ${status === s ? '' : 'btn-ghost'}`}
              onClick={() => setStatus(s)}>
              {s.replace(/_/g, ' ')}
            </button>
          ))}
          <span style={{width:8}}/>
          {TYPE_FILTERS.map(t => (
            <button key={t} className={`btn btn-sm ${type === t ? '' : 'btn-ghost'}`}
              onClick={() => setType(t)}>
              {t.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="dt-wrap" style={{flex:1, overflow:'auto'}}>
        <table className="dt">
          <thead>
            <tr>
              <th>Call Sign</th>
              <th>Name</th>
              <th>Type</th>
              <th style={{width:160}}>Status</th>
              <th style={{width:60}}>Tier</th>
              <th style={{width:60}}>Region</th>
              <th style={{width:70}}>Rating</th>
              <th className="num" style={{width:70}}>Jobs</th>
              <th className="num" style={{width:100}}>Rate/hr</th>
              <th style={{width:80}}>On Duty</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={10}><SkeletonRows rows={8} /></td></tr>
            )}
            {error && (
              <tr><td colSpan={10} style={{padding:24,textAlign:'center',color:'var(--err)'}}>
                Failed to load agents · {String((error as Error).message)}
              </td></tr>
            )}
            {!isLoading && !error && agents.length === 0 && (
              <tr><td colSpan={10} style={{padding:24,textAlign:'center',color:'var(--tx-3)'}}>
                No agents yet — register one from the mobile app.
              </td></tr>
            )}
            {agents.map(a => {
              const callsign = callSign(a);
              const display  = nameOf(a);
              const cls      = STATUS_CLASS[a.status] ?? '';
              const tierLbl  = a.tier > 0 ? `T${a.tier}` : '—';
              const ratingLbl = a.rating ? `★ ${a.rating}` : '—';
              return (
                <Link key={a.user_id} href={routes.people.agent(a.user_id)} legacyBehavior>
                  <tr>
                    <td className="dt-idcell">{callsign}</td>
                    <td>
                      <div className="dt-client">
                        <div className="dt-client-av">{display.slice(0,2).toUpperCase()}</div>
                        <div><div className="dt-client-name">{display}</div></div>
                      </div>
                    </td>
                    <td><span className="pill">{a.type.toUpperCase()}</span></td>
                    <td><span className={`pill ${cls}`}>● {a.status.replace(/_/g, ' ')}</span></td>
                    <td><span style={{fontFamily:'var(--font-mono)',fontWeight:800,color:'var(--glow)',fontSize:11}}>{tierLbl}</span></td>
                    <td><span style={{fontFamily:'var(--font-mono)',fontSize:10,letterSpacing:1.2,color:'var(--tx-2)'}}>{regionLabel(a)}</span></td>
                    <td><span style={{fontFamily:'var(--font-mono)',color:'var(--warn)',fontWeight:700}}>{ratingLbl}</span></td>
                    <td className="num">{a.jobs_total}</td>
                    <td className="num">{rateLabel(a)}</td>
                    <td>
                      <span style={{display:'inline-flex',alignItems:'center',gap:6,fontFamily:'var(--font-mono)',fontSize:9.5,color:a.on_duty ? 'var(--ok)' : 'var(--tx-3)',letterSpacing:0.8}}>
                        <span style={{width:6,height:6,borderRadius:'50%',background:a.on_duty ? 'var(--ok)' : 'var(--tx-3)',display:'inline-block',boxShadow:a.on_duty ? '0 0 6px var(--ok)' : 'none'}}/>
                        {a.on_duty ? 'ON DUTY' : 'OFF'}
                      </span>
                    </td>
                  </tr>
                </Link>
              );
            })}
          </tbody>
        </table>
        {!error && hasMore && (
          <div style={{padding:'10px 0', textAlign:'center'}}>
            <button className="btn btn-sm btn-ghost" disabled={isLoadingMore} onClick={loadMore}>
              {isLoadingMore ? 'LOADING…' : `LOAD MORE (${agents.length} loaded)`}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
