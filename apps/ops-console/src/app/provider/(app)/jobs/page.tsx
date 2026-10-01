'use client';

import Link from 'next/link';
import {useEffect, useMemo, useState} from 'react';
import {useSWRConfig} from 'swr';
import {NotGranted, useProvider} from '@/components/provider/ProviderShell';
import {
  AssignCrewDialog, ConfirmDialog, Empty, OfferCard, ProductTag, PvCard, PvPage, StatePill,
} from '@/components/provider/ui';
import {useToast} from '@/components/Toast';
import {
  pvApi, usePvCompleted, usePvMissions, usePvOffer, usePvRoster, type OrgMission,
} from '@/lib/provider/api';
import {productOf, serviceLabel, when, type Product} from '@/lib/provider/labels';
import {pvRoutes} from '@/lib/provider/routes';

type Tab = 'needs' | 'active' | 'history';
type Filter = 'all' | Product;

type Pending =
  | {kind: 'dispatch'; m: OrgMission}
  | {kind: 'complete'; m: OrgMission}
  | {kind: 'withdraw'; m: OrgMission};

export default function ProviderJobs() {
  const {orgId, can} = useProvider();
  const jobs = can('jobs');
  const offers = can('jobs', 'portal');
  const {data: board, error} = usePvMissions(orgId, jobs);
  const {data: completed} = usePvCompleted(orgId, jobs);
  const {data: offer} = usePvOffer(orgId, offers);
  const {data: roster} = usePvRoster(orgId, jobs);
  const {mutate} = useSWRConfig();
  const {push} = useToast();

  const [tab, setTab] = useState<Tab>('needs');
  const [filter, setFilter] = useState<Filter>('all');
  const [assign, setAssign] = useState<OrgMission | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  // /jobs?assign=<bookingId> (from the overview) opens the crew dialog.
  useEffect(() => {
    if (!board) return;
    const id = new URLSearchParams(window.location.search).get('assign');
    if (!id) return;
    const job = board.needs_crew.find(m => m.booking_id === id);
    if (job) setAssign(job);
    window.history.replaceState(null, '', pvRoutes.jobs);
  }, [board]);

  const refresh = () => mutate((k: unknown) => Array.isArray(k) && k[0] === 'pv');

  const history = useMemo(() => {
    const seen = new Set<string>();
    const rows: OrgMission[] = [];
    for (const m of [...(board?.recent ?? []), ...(completed?.missions ?? [])]) {
      if (seen.has(m.booking_id)) continue;
      seen.add(m.booking_id); rows.push(m);
    }
    return rows.sort((a, b) => b.pickup_time.localeCompare(a.pickup_time));
  }, [board, completed]);

  if (!jobs && !offers) return <PvPage title="Jobs"><NotGranted what="Missions"/></PvPage>;

  const lists: Record<Tab, OrgMission[]> = {
    needs: board?.needs_crew ?? [], active: board?.active ?? [], history,
  };
  const rows = lists[tab].filter(m => filter === 'all' || productOf(m.service) === filter);
  const count = (t: Tab) => lists[t].filter(m => filter === 'all' || productOf(m.service) === filter).length;

  return (
    <PvPage title="Jobs" subtitle="Lite and Executive jobs your agency has accepted: crew them, dispatch, follow them live and close them.">
      {offers && offer && (
        <PvCard title="Live offer">
          <OfferCard key={offer.offer_id} offer={offer} onDone={(msg, ok) => { push({kind: ok ? 'ok' : 'err', text: msg}); void refresh(); }}/>
        </PvCard>
      )}

      {!jobs ? <NotGranted what="Missions"/> : (
        <PvCard pad={false}>
          <div className="pv-toolbar">
            <div className="pv-tabs" role="tablist">
              {([['needs', 'Needs crew'], ['active', 'Active'], ['history', 'History']] as const).map(([k, l]) => (
                <button key={k} role="tab" aria-selected={tab === k}
                  className={`pv-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
                  {l}<span className="pv-tab-n">{count(k)}</span>
                </button>
              ))}
            </div>
            <div className="pv-seg" aria-label="Product">
              {([['all', 'All'], ['lite', 'Lite'], ['executive', 'Executive']] as const).map(([k, l]) => (
                <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>
              ))}
            </div>
          </div>

          {error ? <Empty>Could not load jobs. It will retry automatically.</Empty>
            : !board ? <Empty>Loading…</Empty>
            : rows.length === 0 ? <Empty>{tab === 'needs' ? 'Every accepted job has a crew.' : tab === 'active' ? 'No missions are running.' : 'No finished jobs yet.'}</Empty>
            : (
              <div className="pv-table-wrap">
                <table className="pv-table">
                  <thead>
                    <tr>
                      <th>Job</th><th>Service</th><th>Pick-up</th><th>Crew</th><th>Status</th><th aria-label="Actions"/>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(m => {
                      const lead = m.crew.find(c => c.is_lead);
                      return (
                        <tr key={m.booking_id}>
                          <td>
                            <div className="pv-mono">{m.short_code ?? m.booking_id.slice(0, 8).toUpperCase()}</div>
                            <ProductTag service={m.service}/>
                          </td>
                          <td>
                            <div>{serviceLabel(m)}</div>
                            <div className="pv-cell-sub">{m.region_label}{m.duration_hours ? ` · ${m.duration_hours} h` : ''}{m.armed_required ? ' · armed' : ''}</div>
                          </td>
                          <td>
                            <div>{when(m.pickup_time)}</div>
                            <div className="pv-cell-sub pv-ellipsis" title={m.pickup_address}>{m.pickup_address}</div>
                          </td>
                          <td>
                            {m.crew.length === 0 ? <span className="pv-cell-sub">{m.cpo_count} needed</span> : (
                              <>
                                <div>{lead?.call_sign ?? '—'} <span className="pv-cell-sub">lead</span></div>
                                <div className="pv-cell-sub">{m.crew.length} officer{m.crew.length > 1 ? 's' : ''}</div>
                              </>
                            )}
                          </td>
                          <td><StatePill m={m}/></td>
                          <td className="pv-row-actions">
                            {!m.mission_id && m.booking_status === 'CONFIRMED' && (
                              <>
                                <button className="btn btn-sm btn-ghost" onClick={() => setPending({kind: 'withdraw', m})}>Return</button>
                                <button className="btn btn-sm btn-pri" onClick={() => setAssign(m)}>Assign crew</button>
                              </>
                            )}
                            {m.mission_id && m.mission_status === 'CREWED' && (
                              <button className="btn btn-sm btn-pri" onClick={() => setPending({kind: 'dispatch', m})}>Dispatch</button>
                            )}
                            {m.mission_id && (m.mission_status === 'LIVE' || m.mission_status === 'SOS') && (
                              <button className="btn btn-sm btn-sec" onClick={() => setPending({kind: 'complete', m})}>Complete</button>
                            )}
                            {m.mission_id && m.mission_status !== 'COMPLETED' && m.mission_status !== 'ABORTED' && (
                              <Link className="btn btn-sm btn-ghost" href={pvRoutes.mission(m.mission_id)}>Track</Link>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </PvCard>
      )}

      <AssignCrewDialog job={assign} roster={roster} onClose={() => setAssign(null)}
        onDone={msg => { setAssign(null); push({kind: 'ok', text: msg}); setTab('active'); void refresh(); }}/>

      <ConfirmDialog
        open={pending?.kind === 'dispatch'}
        title="Dispatch the crew?"
        description="Tell the crew to move now. They are notified on their phones, and the client sees the team is on the way."
        confirmLabel="Dispatch"
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending?.kind !== 'dispatch' || !pending.m.mission_id) return;
          await pvApi.dispatch(pending.m.mission_id);
          setPending(null); push({kind: 'ok', text: `Mission ${pending.m.short_code ?? ''} dispatched.`}); void refresh();
        }}/>
      <ConfirmDialog
        open={pending?.kind === 'complete'}
        title="Confirm completion?"
        description="Close this mission for your crew. Only confirm once the client has been handed over safely. Payment is released by the usual checks."
        confirmLabel="Confirm completion"
        danger
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending?.kind !== 'complete' || !pending.m.mission_id) return;
          await pvApi.complete(pending.m.mission_id);
          setPending(null); push({kind: 'ok', text: 'Mission completed.'}); void refresh();
        }}/>
      <ConfirmDialog
        open={pending?.kind === 'withdraw'}
        title="Return this job?"
        description="Give the job back so another agency can take it. You can only do this before a crew is assigned. The client keeps their booking."
        confirmLabel="Return job"
        danger
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending?.kind !== 'withdraw') return;
          await pvApi.withdraw(pending.m.booking_id);
          setPending(null); push({kind: 'ok', text: 'Job returned.'}); void refresh();
        }}/>
    </PvPage>
  );
}
