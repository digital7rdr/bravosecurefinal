'use client';

/**
 * Job Portal — the app's JobPortalScreen on the web. Every agency sees every
 * open job (coarse only: region and area, time, service, officers, price;
 * never the exact address or the client). The first agency to accept wins it;
 * it then sits on Missions under "Needs crew".
 */

import Link from 'next/link';
import {useEffect, useRef, useState} from 'react';
import {useSWRConfig} from 'swr';
import {NotGranted, useProvider} from '@/components/provider/ProviderShell';
import {ConfirmDialog, Empty, PvCard, PvPage, Stat} from '@/components/provider/ui';
import {useToast} from '@/components/Toast';
import {
  REGIONS, actsAsAgency, agencyApi, agencyErrorText, claimErrorText, isSupportedRegion, jobAvailability,
  regionName, useAgentMe, useOpenJobs, type OpenJob,
} from '@/lib/provider/api-agency';
import {credits, serviceLabel, when} from '@/lib/provider/labels';
import {pvRoutes} from '@/lib/provider/routes';

const AVAILABILITY_LABEL = {
  awaiting_approval: 'Waiting for Bravo Secure approval',
  assigned_by_bravo: 'Assigned by Bravo Secure',
} as const;

export default function ProviderJobPortal() {
  const {context, orgId, can} = useProvider();
  const granted = can('portal');
  const self = actsAsAgency(context, orgId);
  const on = granted && self;

  const [region, setRegion] = useState('ALL');
  const touched = useRef(false);
  const {data: me} = useAgentMe(orgId, on);
  const {data, error} = useOpenJobs(orgId, region, on);
  const {mutate} = useSWRConfig();
  const {push} = useToast();
  const [confirm, setConfirm] = useState<OpenJob | null>(null);
  const [won, setWon] = useState<string | null>(null);

  // Start on the agency's own region, like the app; the person can switch to All.
  useEffect(() => {
    const rc = me?.agent.region_code?.toUpperCase();
    if (!touched.current && rc && isSupportedRegion(rc)) setRegion(rc);
  }, [me]);

  if (!granted) return <PvPage title="Job Portal"><NotGranted what="Job Portal"/></PvPage>;

  if (!self) {
    return (
      <PvPage title="Job Portal">
        <PvCard>
          <p className="text-sm text-t3" style={{margin: 0, lineHeight: 1.6}}>
            The open job list is only available to the agency owner&apos;s account for now. Offers sent
            to your agency still appear on <Link href={pvRoutes.jobs}>Missions</Link>, where you can accept them.
          </p>
        </PvCard>
      </PvPage>
    );
  }

  const jobs = data?.jobs ?? [];
  const claimable = jobs.filter(j => jobAvailability(j) === 'claimable').length;
  const refresh = () => mutate((k: unknown) => Array.isArray(k) && k[0] === 'pv' && k[1] === orgId);

  async function claim(job: OpenJob) {
    try {
      await agencyApi.claimOpenJob(job.booking_id);
      setConfirm(null);
      setWon(job.booking_id);
      push({kind: 'ok', text: 'Job accepted. Assign a crew and a lead from Missions to dispatch it.'});
    } catch (e) {
      setConfirm(null);
      push({kind: 'err', text: claimErrorText(e)});
    } finally {
      // Won or lost, the list changed.
      void refresh();
    }
  }

  const pickRegion = (code: string) => { touched.current = true; setRegion(code); };

  return (
    <PvPage title="Job Portal"
      subtitle="Open requests from clients, shown to every agency. The first agency to accept wins the job. The exact pick-up address is shown after you accept."
      right={<button className="btn btn-ghost" onClick={() => void refresh()}>Refresh</button>}>
      <div className="kpi-row" style={{gridTemplateColumns: 'repeat(3, minmax(0, 1fr))'}}>
        <Stat label="Open jobs" value={data ? jobs.length : '—'}/>
        <Stat label="Ready to accept" value={data ? claimable : '—'} tone="ok"/>
        <Stat label="Your region" value={regionName(me?.agent.region_code)}/>
      </div>

      {won && (
        <div className="pv-banner" role="status" style={{marginBottom: 16}}>
          Job accepted. It is on <Link href={pvRoutes.jobs}>Missions</Link> under Needs crew.
          Your agency should crew it within 15 minutes.{' '}
          <Link href={pvRoutes.assign(won)}>Assign crew now</Link>
        </div>
      )}

      <PvCard pad={false}>
        <div className="pv-toolbar">
          <div className="pv-seg" role="tablist" aria-label="Region">
            <button className={region === 'ALL' ? 'on' : ''} onClick={() => pickRegion('ALL')}>All regions</button>
            {REGIONS.map(r => (
              <button key={r.code} className={region === r.code ? 'on' : ''} onClick={() => pickRegion(r.code)}>{r.name}</button>
            ))}
          </div>
        </div>
        {error && !data ? <Empty>{agencyErrorText(error)}</Empty>
          : !data ? <Empty>Loading jobs…</Empty>
          : jobs.length === 0 ? (
            <Empty>
              {region === 'ALL'
                ? 'No open jobs right now. New client requests appear here for every agency, and the first to accept wins.'
                : `No open jobs in ${regionName(region)} right now.`}
            </Empty>
          ) : (
            <div className="pv-table-wrap">
              <table className="pv-table">
                <thead><tr><th>Job</th><th>Area</th><th>When</th><th>Officers</th><th>Price</th><th aria-label="Actions"/></tr></thead>
                <tbody>
                  {jobs.map(j => {
                    const a = jobAvailability(j);
                    return (
                      <tr key={j.booking_id}>
                        <td>
                          <div className="pv-strong">{serviceLabel(j)}</div>
                          {j.armed_required && <span className="pill pill-warn">Armed officers</span>}
                        </td>
                        <td>{j.region_label}{j.pickup_area ? <div className="pv-cell-sub">{j.pickup_area}</div> : null}</td>
                        <td>{when(j.pickup_time)}<div className="pv-cell-sub">{j.duration_hours} h</div></td>
                        <td className="pv-num">{j.cpo_count}</td>
                        <td>
                          <div className="pv-strong">{credits(Number(j.total_eur))}</div>
                          <div className="pv-cell-sub">AED {j.total_aed}</div>
                        </td>
                        <td className="pv-row-actions">
                          {a === 'claimable'
                            ? <button className="btn btn-sm btn-pri" onClick={() => setConfirm(j)}>Accept job</button>
                            : <span className="pv-cell-sub">{AVAILABILITY_LABEL[a]}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </PvCard>

      <ConfirmDialog open={!!confirm} title="Accept this job?" confirmLabel="Accept job"
        description={confirm ? <>
          {serviceLabel(confirm)} · {confirm.cpo_count} officer{confirm.cpo_count > 1 ? 's' : ''}
          {confirm.armed_required ? ', armed' : ''} · {confirm.region_label} · {when(confirm.pickup_time)} · {credits(Number(confirm.total_eur))}.
          {' '}Your agency commits to crewing it within 15 minutes.
        </> : ''}
        onConfirm={() => claim(confirm as OpenJob)}
        onClose={() => setConfirm(null)}/>
    </PvPage>
  );
}
