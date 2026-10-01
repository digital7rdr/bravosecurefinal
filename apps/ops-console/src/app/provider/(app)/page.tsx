'use client';

import Link from 'next/link';
import {useMemo} from 'react';
import {useSWRConfig} from 'swr';
import {useProvider} from '@/components/provider/ProviderShell';
import {Empty, OfferCard, ProductTag, PvCard, PvPage, Stat, StatePill} from '@/components/provider/ui';
import {BravoMap, type BravoMarker} from '@/components/BravoMapLazy';
import {useToast} from '@/components/Toast';
import {usePvMissions, usePvOffer, usePvSummary} from '@/lib/provider/api';
import {serviceLabel, when} from '@/lib/provider/labels';
import {pvRoutes} from '@/lib/provider/routes';

export default function ProviderOverview() {
  const {orgId, org, can, context} = useProvider();
  const jobs = can('jobs');
  const offers = can('jobs', 'portal');
  const {data: sum} = usePvSummary(orgId);
  const {data: board} = usePvMissions(orgId, jobs);
  const {data: offer} = usePvOffer(orgId, offers);
  const {mutate} = useSWRConfig();
  const {push} = useToast();

  const markers = useMemo<BravoMarker[]>(() => (board?.active ?? []).flatMap(m => {
    const lat = Number(m.pickup_lat), lng = Number(m.pickup_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return [];
    return [{id: m.booking_id, lat, lng, type: m.mission_status === 'SOS' ? 'sos' : 'live',
      label: `${m.short_code ?? ''} · ${serviceLabel(m)}`}];
  }), [board]);

  const first = (context.user.display_name ?? '').split(/\s+/)[0];

  return (
    <PvPage
      title={first ? `Welcome back, ${first}` : 'Overview'}
      subtitle={`${org.name || 'Your agency'} · what needs you right now`}>
      <div className="kpi-row" style={{gridTemplateColumns: 'repeat(5, minmax(0, 1fr))'}}>
        <Stat label="Officers free" value={sum ? sum.guards_free : '—'} sub={sum ? `of ${sum.guards_total} on the roster` : undefined} tone="ok"/>
        <Stat label="On duty" value={sum ? sum.guards_on_duty : '—'} tone="info"/>
        <Stat label="Active missions" value={sum ? sum.active_missions : '—'} tone="act"/>
        <Stat label="Needs crew" value={jobs ? (board ? board.needs_crew.length : '—') : '—'}
          tone={board && board.needs_crew.length > 0 ? 'warn' : undefined}/>
        <Stat label="Rating" value={sum?.org_rating != null ? sum.org_rating.toFixed(1) : '—'}
          sub={sum ? `${sum.org_jobs_total} jobs done` : undefined}/>
      </div>

      <div className="pv-grid">
        <div className="pv-col">
          {offers && (
            <PvCard title="Live offer" right={<span className="pv-hint">Refreshes every few seconds</span>}>
              {offer ? (
                <OfferCard key={offer.offer_id} offer={offer} onDone={(msg, ok) => {
                  push({kind: ok ? 'ok' : 'err', text: msg});
                  void mutate((k: unknown) => Array.isArray(k) && k[0] === 'pv');
                }}/>
              ) : (
                <Empty>No offer right now. New Lite and Executive jobs near you appear here, and stay open for a short time.</Empty>
              )}
            </PvCard>
          )}

          {jobs && (
            <PvCard title="Needs crew" right={<Link href={pvRoutes.jobs}>Open jobs →</Link>} pad={false}>
              {!board ? <Empty>Loading…</Empty>
                : board.needs_crew.length === 0 ? <Empty>Every accepted job has a crew.</Empty>
                : (
                  <ul className="pv-list">
                    {board.needs_crew.slice(0, 6).map(m => (
                      <li key={m.booking_id}>
                        <Link href={pvRoutes.assign(m.booking_id)} className="pv-list-row">
                          <ProductTag service={m.service}/>
                          <span className="pv-list-main">
                            <span>{serviceLabel(m)}</span>
                            <span className="pv-list-sub">{when(m.pickup_time)} · {m.region_label} · {m.cpo_count} officer{m.cpo_count > 1 ? 's' : ''}</span>
                          </span>
                          <span className="btn btn-sm btn-sec">Assign</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
            </PvCard>
          )}
        </div>

        {jobs && (
          <div className="pv-col">
            <PvCard title="Active missions" right={<span>{board?.active.length ?? 0}</span>} pad={false}>
              <div className="pv-map"><BravoMap markers={markers} followUser={markers.length === 0}/></div>
              {board && board.active.length > 0 && (
                <ul className="pv-list">
                  {board.active.slice(0, 6).map(m => (
                    <li key={m.booking_id}>
                      <Link href={m.mission_id ? pvRoutes.mission(m.mission_id) : pvRoutes.jobs} className="pv-list-row">
                        <span className="pv-mono">{m.short_code ?? '—'}</span>
                        <span className="pv-list-main">
                          <span>{serviceLabel(m)}</span>
                          <span className="pv-list-sub">{m.crew.find(c => c.is_lead)?.call_sign ?? 'No lead'} · {m.pickup_address}</span>
                        </span>
                        <StatePill m={m}/>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </PvCard>
          </div>
        )}
      </div>

      {!jobs && !offers && (
        <PvCard title="Your access">
          <p className="text-sm text-t3" style={{margin: 0}}>
            Your agency owner has not given you Missions or Job portal access, so jobs and offers are hidden.
          </p>
        </PvCard>
      )}
    </PvPage>
  );
}
