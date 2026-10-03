'use client';

import Link from 'next/link';
import {useParams} from 'next/navigation';
import {useMemo, useState} from 'react';
import useSWR, {useSWRConfig} from 'swr';
import {NotGranted, useProvider} from '@/components/provider/ProviderShell';
import {ConfirmDialog, Empty, ProductTag, PvCard, PvPage, StatePill} from '@/components/provider/ui';
import {BravoMap, type BravoMarker} from '@/components/BravoMapLazy';
import {useToast} from '@/components/Toast';
import {decodePolyline} from '@/lib/polyline';
import {pvApi, usePvLive, usePvMissions} from '@/lib/provider/api';
import {credits, serviceLabel, when} from '@/lib/provider/labels';
import {pvRoutes} from '@/lib/provider/routes';
import {MissionVehicles} from '@/components/provider/MissionVehicles';

const num = (v: string | number | null | undefined) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n !== 0 ? n : null;
};

const WAYPOINT: Record<string, string> = {
  DISPATCH: 'Dispatched', RECON: 'Recon', PICKUP: 'Pick-up', DROPOFF: 'Drop-off',
  CHKPT01: 'Checkpoint 1', CHKPT02: 'Checkpoint 2',
};

export default function ProviderMission() {
  const {missionId} = useParams<{missionId: string}>();
  const {orgId, can} = useProvider();
  const jobs = can('jobs');
  const earn = can('jobs', 'earn');
  const {data: live, error} = usePvLive(jobs ? orgId : null, missionId);
  const {data: board} = usePvMissions(orgId, jobs);
  const job = useMemo(() => [...(board?.active ?? []), ...(board?.recent ?? [])].find(m => m.mission_id === missionId) ?? null, [board, missionId]);
  const bookingId = live?.mission?.booking_id ?? job?.booking_id ?? null;
  const {data: escrow} = useSWR(earn && bookingId ? ['pv', orgId, `escrow:${bookingId}`] : null, () => pvApi.escrow(bookingId as string));
  const {mutate} = useSWRConfig();
  const {push} = useToast();
  const [confirm, setConfirm] = useState<'dispatch' | 'complete' | null>(null);

  const {markers, route} = useMemo(() => {
    const out: BravoMarker[] = [];
    const b = live?.booking, m = live?.mission;
    const pu = [num(b?.pickup_lat), num(b?.pickup_lng)];
    const dr = [num(b?.dropoff_lat), num(b?.dropoff_lng)];
    if (pu[0] && pu[1]) out.push({id: 'pickup', lat: pu[0], lng: pu[1], type: 'pickup', label: 'Pick-up'});
    if (dr[0] && dr[1]) out.push({id: 'dropoff', lat: dr[0], lng: dr[1], type: 'dropoff', label: 'Drop-off'});
    if (num(m?.client_lat) && num(m?.client_lng)) out.push({id: 'client', lat: m!.client_lat as number, lng: m!.client_lng as number, type: 'principal', label: 'Client'});
    if (num(m?.current_lat) && num(m?.current_lng)) out.push({id: 'lead', lat: m!.current_lat as number, lng: m!.current_lng as number, type: 'lead', label: 'Lead officer'});
    return {markers: out, route: m?.route_polyline ? decodePolyline(m.route_polyline) : undefined};
  }, [live]);

  if (!jobs) return <PvPage title="Mission"><NotGranted what="Missions"/></PvPage>;

  const m = live?.mission;
  const status = m?.status ?? job?.mission_status ?? null;
  const center = markers.find(x => x.type === 'lead') ?? markers[0];
  const refresh = () => mutate((k: unknown) => Array.isArray(k) && k[0] === 'pv');

  return (
    <PvPage
      title={<>Mission <span className="pv-mono">{m?.short_code ?? job?.short_code ?? ''}</span></>}
      subtitle={<Link href={pvRoutes.jobs}>← All jobs</Link>}
      right={<>
        {job && <StatePill m={job}/>}
        {status === 'CREWED' && <button className="btn btn-pri" onClick={() => setConfirm('dispatch')}>Dispatch</button>}
        {(status === 'LIVE' || status === 'SOS') && <button className="btn btn-sec" onClick={() => setConfirm('complete')}>Confirm completion</button>}
      </>}>
      {error ? <PvCard><Empty>This mission could not be loaded. It may belong to another agency or no longer exist.</Empty></PvCard> : (
        <div className="pv-grid pv-grid-wide">
          <PvCard title="Live position" right={<span className="pv-hint">Updates every 5 seconds</span>} pad={false}>
            <div className="pv-map pv-map-tall">
              <BravoMap markers={markers} route={route}
                center={center ? [center.lng, center.lat] : undefined} zoom={center ? 13 : 11}/>
            </div>
            <div className="pv-legend">
              <span><i style={{background: '#1E88FF'}}/>Lead officer</span>
              <span><i style={{background: '#4CC2FF'}}/>Client</span>
              <span><i style={{background: '#00C853'}}/>Pick-up</span>
              <span><i style={{background: '#FFC107'}}/>Drop-off</span>
            </div>
          </PvCard>

          <div className="pv-col">
            <PvCard title="Job">
              {!live && !job ? <Empty>Loading…</Empty> : (
                <dl className="pv-facts pv-facts-col">
                  <div><dt>Service</dt><dd>{job && <ProductTag service={job.service}/>} {job ? serviceLabel(job) : live?.booking?.service ?? '—'}</dd></div>
                  <div><dt>Pick-up</dt><dd>{live?.booking?.pickup_address ?? job?.pickup_address ?? '—'}</dd></div>
                  <div><dt>Drop-off</dt><dd>{live?.booking?.dropoff_address ?? job?.dropoff_address ?? '—'}</dd></div>
                  <div><dt>Time</dt><dd>{when(job?.pickup_time)}</dd></div>
                  <div><dt>Client received</dt><dd>{when(m?.live_at ?? job?.live_at)}</dd></div>
                  <div><dt>Last client fix</dt><dd>{when(m?.client_recorded_at)}</dd></div>
                </dl>
              )}
            </PvCard>

            <PvCard title="Crew" pad={false}>
              {!job ? <Empty>Loading…</Empty> : job.crew.length === 0 ? <Empty>No crew assigned.</Empty> : (
                <ul className="pv-list">
                  {job.crew.map(c => (
                    <li key={c.user_id} className="pv-list-row">
                      <span className="pv-mono">{c.call_sign ?? '—'}</span>
                      <span className="pv-list-main"><span>{c.is_lead ? 'Lead officer' : 'Officer'}</span></span>
                      {c.is_lead && <span className="pill pill-act">Lead</span>}
                    </li>
                  ))}
                </ul>
              )}
            </PvCard>

            <MissionVehicles orgId={orgId} missionId={missionId} status={status}/>

            <PvCard title="Checkpoints" pad={false}>
              {!live ? <Empty>Loading…</Empty> : live.waypoints.length === 0 ? <Empty>No checkpoints yet.</Empty> : (
                <ol className="pv-steps">
                  {live.waypoints.map(w => (
                    <li key={w.seq} className={w.settled_at ? 'done' : ''}>
                      <span>{WAYPOINT[w.tag] ?? w.tag}</span>
                      <span className="pv-cell-sub">{w.settled_at ? when(w.settled_at) : 'Pending'}</span>
                    </li>
                  ))}
                </ol>
              )}
            </PvCard>

            {earn && (
              <PvCard title="Payment">
                {escrow === undefined ? <Empty>Loading…</Empty> : escrow === null ? <Empty>No payment hold on this job.</Empty> : (
                  <dl className="pv-facts pv-facts-col">
                    <div><dt>Status</dt><dd>{escrow.status.toLowerCase().replace(/_/g, ' ')}</dd></div>
                    <div><dt>Job value</dt><dd>{credits(escrow.gross_credits)}</dd></div>
                    <div><dt>Platform fee</dt><dd>{credits(escrow.platform_fee_credits)}</dd></div>
                    <div><dt>To your agency</dt><dd className="pv-strong">{credits(escrow.to_provider_credits)}</dd></div>
                  </dl>
                )}
              </PvCard>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog open={confirm === 'dispatch'} title="Dispatch the crew?"
        description="Tell the crew to move now. They are notified on their phones."
        confirmLabel="Dispatch" onClose={() => setConfirm(null)}
        onConfirm={async () => { await pvApi.dispatch(missionId); setConfirm(null); push({kind: 'ok', text: 'Crew dispatched.'}); void refresh(); }}/>
      <ConfirmDialog open={confirm === 'complete'} title="Confirm completion?" danger
        description="Close this mission for your crew. Only confirm once the client has been handed over safely."
        confirmLabel="Confirm completion" onClose={() => setConfirm(null)}
        onConfirm={async () => { await pvApi.complete(missionId); setConfirm(null); push({kind: 'ok', text: 'Mission completed.'}); void refresh(); }}/>
    </PvPage>
  );
}
